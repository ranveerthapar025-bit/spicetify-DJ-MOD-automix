// NAME: DJ Mix
// DESCRIPTION: Real DJ transitions in Spotify. Uses Spotify's own (hidden) automix engine to overlap the end of one
//              song with the next, beat-matched and tempo-synced, like Apple Music's AutoMix. On accounts where
//              that engine is unavailable (Spotify Free), it falls back to a smooth, recipe-timed fade.
// VERSION: 0.5.0
//
// How it works
//   Beat-match engine (Premium)
//     Spotify ships a native transition engine for its playlist "Mix" feature. Its editor can preview a transition
//     between any two tracks via the player signal "automix-preview". DJ Mix asks Spotify's server for the best
//     transition between the current and next track (PlaylistMixingAPI.getAutoTransitionForTrackPair) and fires that
//     preview just before the mix point, rewritten so the outgoing song keeps playing from exactly where it is.
//     Once the first mix fires, the player sits in Spotify's "automix" mode. DJ Mix stays there and chains every
//     following transition (no restarts = no stutter), following a snapshot of your up-next list.
//
//   Smooth fade engine (Free, and fallback)
//     Spotify Free silently ignores the automix preview, and the desktop player can only play one stream, so a true
//     overlap is impossible there. Instead DJ Mix still asks Spotify for the transition recipe, fades the outgoing song
//     out with an equal-power curve exactly at the mix point, skips, starts the next song at the entry point Spotify
//     picked (past dead intros), and fades it in. It also covers pairs Spotify has no transition for and songs you
//     queued, which used to just cut.

(function djmix() {
  const S = window.Spicetify;
  const P = S?.Platform;
  if (!S?.Playbar?.Button || !S?.PopupModal || !S?.LocalStorage || !P?.PlayerAPI) {
    setTimeout(djmix, 300);
    return;
  }
  // The mixing module can register a little after the player. Give it a few seconds, then run without it.
  djmix.waited = (djmix.waited || 0) + 1;
  if (!P.PlaylistMixingAPI && djmix.waited < 30) {
    setTimeout(djmix, 300);
    return;
  }

  const A = P.PlayerAPI;
  const M = P.PlaylistMixingAPI;
  const previewPlayer = M?._transitionAPI?._previewPlayer;
  const hasRecipes = typeof M?.getAutoTransitionForTrackPair === "function";
  const hasNative = hasRecipes && typeof M.playTransitionPreview === "function" && !!previewPlayer;
  if (!hasNative) console.warn("[DJ Mix] This Spotify build has no beat-match engine; using Smooth fade.");

  // ---------------------------------------------------------------- settings

  const SETTINGS_KEY = "djmix:v2";
  // engine: "auto" (beat-match when the account supports it, else fade) | "native" | "fade".
  // beatOnly / maxTempo: filters for beat-match mixes. fadeSec: fade length. smartEntry: start the next song where
  // Spotify's recipe says (skips dead intros). fallbackFade: fade when beat-match can't mix a pair.
  const DEFAULTS = {
    enabled: true, notify: true, marker: true, beatOnly: false, maxTempo: 0,
    engine: "auto", fadeSec: 6, smartEntry: true, fallbackFade: true,
  };
  const loadJSON = (key, fallback) => {
    try {
      const v = JSON.parse(S.LocalStorage.get(key) || "null");
      return v && typeof v === "object" ? v : fallback;
    } catch {
      return fallback;
    }
  };
  const saveJSON = (key, v) => {
    try {
      S.LocalStorage.set(key, JSON.stringify(v));
    } catch {}
  };
  const dropKey = (key) => {
    try {
      S.LocalStorage.remove(key);
    } catch {
      saveJSON(key, null);
    }
  };
  const settings = { ...DEFAULTS, ...loadJSON(SETTINGS_KEY, {}) };
  const saveSettings = () => saveJSON(SETTINGS_KEY, settings);

  // Mix history (last few mixes) and lifetime stats, kept across restarts.
  const HISTORY_KEY = "djmix:history";
  const STATS_KEY = "djmix:stats";
  const HISTORY_MAX = 12;
  const history = Array.isArray(loadJSON(HISTORY_KEY, [])) ? loadJSON(HISTORY_KEY, []) : [];
  const stats = { mixes: 0, beatmatched: 0, overlapMs: 0, tempoSum: 0, fades: 0, ...loadJSON(STATS_KEY, {}) };

  // ---------------------------------------------------------------- helpers

  const log = (...a) => console.log("%c[DJ Mix]", "color:#1ed760;font-weight:bold", ...a);
  const fmt = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const state = () => A.getState();
  const posOf = (st) =>
    !st ? 0 : st.positionAsOfTimestamp + (st.isPaused ? 0 : (Date.now() - st.timestamp) * (st.speed || 1));
  const isTrack = (uri) => typeof uri === "string" && uri.startsWith("spotify:track:");
  const previewActive = () => {
    try {
      return !!M?.isTransitionPreviewActive();
    } catch {
      return false;
    }
  };
  const ref = (item) => item && { uri: item.uri, uid: item.uid, name: item.name, provider: item.provider };
  const mixable = (item) => item && isTrack(item.uri) && (!item.provider || item.provider === "context");
  const tempoPct = (ov) => (ov?.isBeatmatched && ov.speedB ? (ov.speedB - 1) * 100 : 0);
  const signedPct = (p) => `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;
  const quiet = (p) => Promise.resolve(p).catch((e) => log("player call failed", e));

  const getVol = () => {
    try {
      const v = S.Player?.getVolume?.() ?? P.PlaybackAPI?._volume;
      return typeof v === "number" && isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };
  const setVol = (v) => {
    try {
      v = clamp(v, 0, 1);
      quiet(S.Player?.setVolume ? S.Player.setVolume(v) : P.PlaybackAPI?.setVolume?.(v));
    } catch {}
  };

  // Main-thread timers get throttled to ~1/s when Spotify is minimised. Worker timers don't, so use one as the clock.
  function startClock(fn, ms) {
    try {
      const w = new Worker(URL.createObjectURL(new Blob([`setInterval(()=>postMessage(0),${ms})`], { type: "text/javascript" })));
      w.onmessage = fn;
      return;
    } catch (e) {
      log("worker clock unavailable, falling back to setInterval", e);
    }
    setInterval(fn, ms);
  }

  // ---------------------------------------------------------------- account / engine choice

  // Spotify Free ignores the automix preview without any error. We find out two ways: the account's product type,
  // and by checking that the player really entered automix mode after a fire. Either one flips "auto" to Smooth fade.
  const NATIVE_KEY = "djmix:native";
  const FREE_TYPES = ["free", "open", "shuffle", "free-tier"];
  let account = "unknown";
  const nativeState = { broken: false, account: "", ...loadJSON(NATIVE_KEY, {}) };
  const isFree = () => FREE_TYPES.includes(account);
  let warnedForced = false;

  (async function detectAccount() {
    try {
      const api = P.ProductStateAPI;
      let v = await api?.getValues?.();
      if (!v && api?.productStateApi?.getValues) v = await api.productStateApi.getValues();
      const t = String(v?.type ?? v?.get?.("type") ?? "").toLowerCase();
      if (t) account = t;
    } catch (e) {
      log("could not read account type", e);
    }
    if (account !== "unknown") {
      // A different account (or an upgrade) gets a fresh chance at the beat-match engine.
      if (nativeState.account && nativeState.account !== account) nativeState.broken = false;
      nativeState.account = account;
      saveJSON(NATIVE_KEY, nativeState);
    }
    log(`account: ${account} · engine: ${engineLabel()}`);
    replan();
  })();

  function useNative() {
    if (!hasNative || settings.engine === "fade") return false;
    if (settings.engine === "native") return true;
    return !isFree() && !nativeState.broken;
  }
  function engineLabel() {
    if (settings.engine === "fade") return "Smooth fade";
    if (!hasNative) return "Smooth fade (this Spotify build has no beat-match engine)";
    if (settings.engine === "native") return "Beat-match only";
    if (isFree()) return "Smooth fade · Free account (beat-matching needs Premium)";
    if (nativeState.broken) return "Smooth fade · Spotify ignored beat-match mixes on this account";
    return settings.fallbackFade ? "Beat-match, smooth fade as backup" : "Beat-match";
  }

  // ---------------------------------------------------------------- protobuf patch
  // The preview signal hard-codes "start 3000 ms before the overlap" (field 5, relative flag in field 6).
  // We rewrite it to an absolute start position = where the song is right now, so nothing audibly jumps.

  function readVarint(bytes, i) {
    let v = 0, mul = 1, b;
    do {
      b = bytes[i++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return [v, i];
  }
  function writeVarint(v) {
    const out = [];
    v = Math.max(0, Math.floor(v));
    while (v >= 0x80) {
      out.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return out;
  }
  function patchStartPosition(b64, absMs) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const out = [];
    let i = 0, patched5 = false, patched6 = false;
    while (i < bytes.length) {
      const start = i;
      const [key, afterKey] = readVarint(bytes, i);
      const field = Math.floor(key / 8), wire = key & 7;
      i = afterKey;
      if (wire === 0) {
        const [, end] = readVarint(bytes, i);
        if (field === 5) { out.push(...bytes.slice(start, afterKey), ...writeVarint(absMs)); patched5 = true; }
        else if (field === 6) { out.push(...bytes.slice(start, afterKey), 0); patched6 = true; }
        else out.push(...bytes.slice(start, end));
        i = end;
      } else if (wire === 2) {
        const [len, afterLen] = readVarint(bytes, i);
        i = afterLen + len;
        out.push(...bytes.slice(start, i));
      } else if (wire === 1) { i += 8; out.push(...bytes.slice(start, i)); }
      else if (wire === 5) { i += 4; out.push(...bytes.slice(start, i)); }
      else return null; // unknown layout: don't touch it
    }
    if (!patched5 || !patched6) return null;
    let s = "";
    for (const b of out) s += String.fromCharCode(b);
    return btoa(s);
  }

  /** Fire Spotify's native transition from track a to b, with track a continuing from `startMs`. */
  async function fireNativeTransition(tr, ctxUri, aUri, bUri, startMs) {
    const realSend = A.sendSignal;
    const realPause = A.pause;
    const realActive = previewPlayer.isTransitionPreviewActive;
    A.pause = async () => {}; // the editor pauses first; we want the music to keep going
    previewPlayer.isTransitionPreviewActive = () => false; // ...and it stops a running preview first; we chain instead
    A.sendSignal = function (sig, payload, ...rest) {
      if (sig === "automix-preview") {
        const patched = patchStartPosition(payload, startMs);
        if (patched) payload = patched;
        else log("could not patch start position; using Spotify's default lead-in");
      }
      return realSend.call(this, sig, payload, ...rest);
    };
    try {
      await M.playTransitionPreview(tr, ctxUri, aUri, bUri);
    } finally {
      A.sendSignal = realSend;
      A.pause = realPause;
      previewPlayer.isTransitionPreviewActive = realActive;
    }
  }

  // ---------------------------------------------------------------- state

  // session: we're in automix mode, following a snapshot of the real up-next list.
  //   { ctxUri, queue: [ref...], idx, pendingIdx, firedAt, settleUntil, ov, lastPlan, confirmed }
  let session = null;
  // plan: native { key, mode:"native", from, to, toIdx, tr, ov, triggerAt }
  //       fade   { key, mode:"fade", from, to, toIdx, ov|null, fadeStart, cutAt, entryB, fadeInMs, triggerAt }
  let plan = null;
  let planKey = "";
  let planning = false;
  let busy = false;
  let lastReason = "";
  let skippedKey = ""; // the one upcoming mix you chose to skip
  let fade = null; // a running smooth fade: { p, phase: "out"|"skip"|"in", v0, lastSet, drift, t0, lastTick, deadline }

  const mixAt = (p) => (p.mode === "fade" ? p.fadeStart : p.ov.startAMs);
  const mixLen = (p) => (p.mode === "fade" ? p.cutAt - p.fadeStart : p.ov.durationMs || 0);

  function curRef(st) {
    if (!session) return ref(st?.item);
    const q = session.queue;
    const byPending = session.pendingIdx != null && q[session.pendingIdx]?.uri === st?.item?.uri ? session.pendingIdx : null;
    return q[byPending ?? session.idx];
  }

  /** Timing for a smooth fade, from Spotify's recipe when there is one, else the end of the song. */
  function makeFadePlan(from, to, toIdx, ov, durA, key) {
    if (!(durA > 20000)) return null;
    const f = clamp((+settings.fadeSec || DEFAULTS.fadeSec) * 1000, 1000, 20000);
    const useOv = !!(ov && ov.startAMs > 30000 && ov.startAMs < durA - 1000);
    let cutAt = durA - 250;
    let entryB = 0;
    if (useOv) {
      // Fade out starting at Spotify's mix point, over (at most) the first half of its overlap.
      cutAt = Math.min(durA - 250, ov.startAMs + Math.min((ov.durationMs || 0) / 2 || f, f));
      if (settings.smartEntry && ov.startBMs > 1500) entryB = Math.min(45000, Math.round(ov.startBMs));
    }
    const fadeStart = Math.max(0, cutAt - f);
    const fadeInMs = entryB > 0 ? Math.min(f, 2500) : Math.min(f, 900);
    return { key, mode: "fade", from, to, toIdx, ov: useOv ? ov : null, fadeStart, cutAt, entryB, fadeInMs, triggerAt: fadeStart };
  }

  async function ensurePlan(from, to, toIdx, st, inSession) {
    const key = `${from?.uri}|${to?.uid ?? to?.uri}|${toIdx}`;
    if (key === planKey || planning) return;
    planKey = key;
    plan = null;
    if (!isTrack(from?.uri)) return void (lastReason = "Not a music track");
    if (!to) return void (lastReason = "Nothing up next");
    if (!isTrack(to.uri)) return void (lastReason = "Next up isn't a song, so it plays normally");
    // The player briefly reports the new song as its own "next" around a song change; never mix a song into itself.
    if (to.uri === from.uri) return void (lastReason = "Next song is the same song");
    if (st.repeat === 2) return void (lastReason = "Repeat-one is on");
    if (key === skippedKey) return void (lastReason = `Skipping this mix; ${to.name ?? "the next song"} plays normally`);

    const native = inSession || (useNative() && mixable(to));
    const canFade = !inSession && (!useNative() || settings.fallbackFade);
    if (!native && !canFade) return void (lastReason = "Next song is from your queue, so it plays normally");

    planning = true;
    try {
      let tr = null;
      if (hasRecipes) {
        try {
          tr = await M.getAutoTransitionForTrackPair(from.uri, to.uri);
        } catch (e) {
          log("transition lookup failed", e);
        }
      }
      if (planKey !== key) return;
      const ov = tr?.overlap;
      const hasOv = !!(ov && ov.startAMs > 0);

      if (native && hasOv) {
        if (settings.beatOnly && !ov.isBeatmatched)
          return void (lastReason = "Spotify can't beat-match this pair (beat-matched only is on)");
        const tp = tempoPct(ov);
        if (settings.maxTempo > 0 && Math.abs(tp) > settings.maxTempo)
          return void (lastReason = `Tempo change ${signedPct(tp)} is over your ${settings.maxTempo}% limit`);
        plan = { key, mode: "native", from, to, toIdx, tr, ov, triggerAt: ov.startAMs - 1500 };
        lastReason = "";
        log(`planned: "${from.name ?? from.uri}" → "${to.name}" at ${fmt(ov.startAMs)}`, ov);
        return;
      }
      if (!canFade) return void (lastReason = "Spotify has no transition for this pair");
      const fp = makeFadePlan(from, to, toIdx, hasOv ? ov : null, st.duration, key);
      if (!fp) return void (lastReason = "Song is too short to fade");
      plan = fp;
      lastReason = "";
      log(`planned fade: "${from.name ?? from.uri}" → "${to.name}" at ${fmt(fp.fadeStart)}–${fmt(fp.cutAt)}`, fp);
    } finally {
      planning = false;
    }
  }

  // ---------------------------------------------------------------- firing a beat-match mix

  async function fire(st, p) {
    busy = true;
    plan = null;
    planKey = "";
    const ctxUri = session?.ctxUri ?? st.context?.uri;
    if (!session) {
      // First mix: snapshot the real up-next list so we can keep following it inside automix mode.
      let upNext = (st.nextItems || []).map(ref);
      try {
        const q = await A.getQueue();
        const fromQueue = [...(q?.queued || []), ...(q?.nextUp || [])].map(ref);
        if (fromQueue[0]?.uid === p.to.uid && fromQueue.length >= upNext.length) upNext = fromQueue;
      } catch {}
      if (upNext[0]?.uid !== p.to.uid) upNext = [p.to, ...upNext];
      session = { ctxUri, queue: [ref(st.item), ...upNext.slice(0, 150)], idx: 0 };
    }
    session.pendingIdx = p.toIdx;
    session.firedAt = Date.now();
    session.settleUntil = Date.now() + 1500; // the player reports a few junk states right after a fire
    session.ov = p.ov;
    session.lastPlan = p;
    session.confirmed = false;
    log(`mixing into "${p.to.name}"`);
    if (settings.notify) S.showNotification(`🎧 Mixing into ${p.to.name}${tempoLabel(p.ov)}`);
    try {
      const startMs = Math.round(posOf(state()) + 120); // small lead for the command to reach the player
      await fireNativeTransition(p.tr, ctxUri, p.from.uri, p.to.uri, startMs);
    } catch (e) {
      log("native transition failed", e);
      if (!previewActive()) {
        session = null;
        nativeFailed(p, state());
      } else session.pendingIdx = null;
    } finally {
      busy = false;
    }
  }

  /** The player didn't enter automix mode: remember that, and save this transition with a smooth fade. */
  function nativeFailed(p, st) {
    if (settings.engine === "native") {
      log("Spotify ignored the beat-match transition (Beat-match only is selected, so not falling back).");
      if (!warnedForced) {
        warnedForced = true;
        S.showNotification("DJ Mix: Spotify ignored the beat-match mix. Try Mix engine → Auto in the DJ Mix panel.", true);
      }
      return;
    }
    if (!nativeState.broken) {
      nativeState.broken = true;
      saveJSON(NATIVE_KEY, nativeState);
      log("Spotify ignored the beat-match transition (normal on Spotify Free). Switching to Smooth fade.");
      S.showNotification("🎚️ DJ Mix: beat-matching isn't available on this account. Using Smooth fade instead.");
    }
    if (!settings.enabled || !p || st?.item?.uri !== p.from.uri) return;
    const fp = makeFadePlan(p.from, p.to, p.toIdx, p.ov, st.duration, p.key);
    if (!fp) return;
    const pos = posOf(st);
    fp.fadeStart = Math.max(fp.fadeStart, pos);
    if (fp.cutAt - fp.fadeStart < 2500) fp.cutAt = Math.min(st.duration - 250, fp.fadeStart + 3000);
    if (fp.cutAt - fp.fadeStart > 500) startFade(fp);
  }

  function recordMix(p) {
    const ov = p.ov;
    if (p.mode === "fade") {
      history.unshift({
        at: Date.now(),
        kind: "fade",
        from: p.from.name ?? "",
        to: p.to.name ?? "",
        fadeSec: Math.round((p.cutAt - p.fadeStart) / 1000),
      });
      stats.mixes++;
      stats.fades = (stats.fades || 0) + 1;
    } else {
      const tp = tempoPct(ov);
      history.unshift({
        at: Date.now(),
        kind: "native",
        from: p.from.name ?? "",
        to: p.to.name ?? "",
        beat: !!ov.isBeatmatched,
        bpmA: ov.bpmA ? Math.round(ov.bpmA) : null,
        bpmB: ov.bpmB ? Math.round(ov.bpmB) : null,
        tempo: Math.round(tp * 10) / 10,
        overlapMs: Math.round(ov.durationMs || 0),
      });
      stats.mixes++;
      if (ov.isBeatmatched) stats.beatmatched++;
      stats.overlapMs += ov.durationMs || 0;
      stats.tempoSum += Math.abs(tp);
    }
    history.length = Math.min(history.length, HISTORY_MAX);
    saveJSON(HISTORY_KEY, history);
    saveJSON(STATS_KEY, stats);
  }

  // ---------------------------------------------------------------- smooth fade engine

  // If Spotify closes or reloads mid-fade, the volume would stay turned down. Remember it and put it back on start.
  const RESTORE_KEY = "djmix:restoreVol";
  const pendingRestore = loadJSON(RESTORE_KEY, null);
  if (pendingRestore && typeof pendingRestore.v === "number" && Date.now() - (pendingRestore.at || 0) < 12 * 3600e3) {
    log(`restoring volume ${Math.round(pendingRestore.v * 100)}% left over from an interrupted fade`);
    setTimeout(() => setVol(pendingRestore.v), 1500);
  }
  dropKey(RESTORE_KEY);
  window.addEventListener("beforeunload", () => {
    if (fade && fade.phase !== "user") setVol(fade.v0);
  });

  function startFade(p) {
    const v0 = getVol();
    if (v0 == null) {
      lastReason = "Can't read Spotify's volume, so it can't fade";
      return;
    }
    plan = null;
    fade = { p, phase: "out", v0, lastSet: v0, drift: 0, t0: 0, lastTick: Date.now(), deadline: 0 };
    saveJSON(RESTORE_KEY, { v: v0, at: Date.now() });
    log(`fading into "${p.to.name}"`, p);
    if (settings.notify) S.showNotification(`🎚️ Fading into ${p.to.name}`);
  }

  function applyGain(g) {
    const v = fade.v0 * g;
    if (Math.abs(v - fade.lastSet) < 0.004 && g > 0 && g < 1) return;
    fade.lastSet = v;
    setVol(v);
  }

  /** how: "done" (finished, counts as a mix) | "cancel" (put the volume back) | "user" (you took the volume; leave it). */
  function endFade(how) {
    if (!fade) return;
    const f = fade;
    fade = null;
    if (how !== "user") setVol(f.v0);
    dropKey(RESTORE_KEY);
    if (how === "done") recordMix(f.p);
    else log(`fade ${how === "user" ? "stopped: you changed the volume" : "cancelled"}`);
  }

  function stepFade(st) {
    const now = Date.now();
    const dt = now - fade.lastTick;
    fade.lastTick = now;
    const p = fade.p;

    // You moved the volume slider: stop fading and leave it where you put it. Hold the ramp while we're unsure, so we
    // never overwrite your change (a short hold from a laggy volume read is harmless: fade-out follows the position).
    const v = getVol();
    if (v != null && Math.abs(v - fade.lastSet) > 0.08) {
      if (++fade.drift >= 4) return endFade("user");
      return;
    }
    fade.drift = 0;

    if (fade.phase === "out") {
      if (st?.item?.uri === p.to.uri) {
        // The song ended on its own a hair before we cut: go straight to the fade-in.
        fade.phase = "in";
        fade.t0 = now;
        return;
      }
      if (!st?.item || st.item.uri !== p.from.uri) return endFade("cancel"); // you skipped or played something else
      const pos = posOf(st);
      if (pos < p.fadeStart - 1500) return endFade("cancel"); // you seeked back
      if (st.isPaused) return;
      const k = clamp((pos - p.fadeStart) / Math.max(1, p.cutAt - p.fadeStart), 0, 1);
      applyGain(Math.cos((k * Math.PI) / 2));
      if (k >= 1 || pos >= (st.duration || Infinity) - 200) {
        applyGain(0);
        fade.phase = "skip";
        fade.deadline = now + 5000;
        Promise.resolve()
          .then(() => orig.skipToNext.call(A))
          .catch((e) => {
            log("skip failed", e);
            endFade("cancel");
          });
      }
      return;
    }

    if (fade.phase === "skip") {
      if (st?.item && st.item.uri !== p.from.uri) {
        if (st.item.uri !== p.to.uri) return endFade("cancel"); // an ad or something else came up
        if (p.entryB > 0) quiet(orig.seekTo.call(A, p.entryB));
        fade.phase = "in";
        fade.t0 = now + (p.entryB > 0 ? 200 : 0); // let the seek land while it's still silent
      } else if (now > fade.deadline) endFade("cancel");
      return;
    }

    // phase "in"
    if (!st?.item || st.item.uri !== p.to.uri) return endFade("cancel");
    if (st.isPaused) {
      fade.t0 += dt;
      return;
    }
    const k = clamp((now - fade.t0) / Math.max(1, p.fadeInMs), 0, 1);
    applyGain(Math.sin((k * Math.PI) / 2));
    if (k >= 1) endFade("done");
  }

  // ---------------------------------------------------------------- leaving automix mode

  async function handBack(target, seekMs) {
    if (busy || !session) return;
    busy = true;
    const st = state();
    const ctxUri = session.ctxUri;
    const wasPaused = st?.isPaused;
    try {
      await A.play(
        { uri: ctxUri },
        { featureIdentifier: "playlist", referrerIdentifier: "other" },
        { skipTo: { uri: target.uri, uid: target.uid }, seekTo: Math.max(0, Math.round(seekMs)) }
      );
      if (wasPaused) await A.pause().catch(() => {});
    } catch (e) {
      log("hand-back failed", e);
      try {
        await M.cleanupTransitionPreview();
      } catch {}
    } finally {
      session = null;
      plan = null;
      planKey = "";
      busy = false;
    }
  }

  // In automix mode Spotify blocks seek / previous and its own "next" would follow the preview's queue,
  // so route them through a hand-back to your real context.
  const orig = { seekTo: A.seekTo, skipToNext: A.skipToNext, skipToPrevious: A.skipToPrevious };
  const inSession = () => session && previewActive();
  A.seekTo = function (ms, ...rest) {
    if (inSession()) {
      const cur = curRef(state());
      return handBack(cur, ms);
    }
    return orig.seekTo.call(this, ms, ...rest);
  };
  A.skipToNext = function (...args) {
    if (inSession()) {
      const st = state();
      const cur = curRef(st);
      const i = session.queue.indexOf(cur);
      const next = session.queue[i + 1];
      if (next && mixable(next)) return handBack(next, 0);
      // Past the end of our snapshot: get back to the real context, then let Spotify skip normally.
      return handBack(cur, posOf(st)).then(() => orig.skipToNext.apply(A, args));
    }
    return orig.skipToNext.apply(this, args);
  };
  A.skipToPrevious = function (...args) {
    if (inSession()) {
      const st = state();
      const cur = curRef(st);
      const i = session.queue.indexOf(cur);
      const prev = posOf(st) < 3000 && i > 0 ? session.queue[i - 1] : cur;
      return handBack(prev, 0);
    }
    return orig.skipToPrevious.apply(this, args);
  };

  // Spotify greys out the back button in automix mode; we handle it, so keep it clickable.
  try {
    const ev = A.getEvents?.();
    const origEmit = ev?.emit;
    if (origEmit) {
      ev.emit = function (type, data, ...rest) {
        const r = data?.data?.restrictions ?? data?.restrictions;
        if (session && r) {
          r.canSkipPrevious = true;
          r.canSeek = true;
          r.disallowSkippingPreviousReasons = [];
          r.disallowSeekingReasons = [];
        }
        return origEmit.call(this, type, data, ...rest);
      };
    }
  } catch (e) {
    log("could not patch player events", e);
  }

  // ---------------------------------------------------------------- engine

  function tick() {
    if (busy) return;
    const st = state();
    if (fade) return stepFade(st);
    if (!st?.item) return;
    const now = Date.now();

    if (session) {
      if (now < session.settleUntil) return;
      if (!previewActive()) {
        // Left automix mode. Straight after a fire that means Spotify ignored the mix (Spotify Free does this).
        const failed = session.pendingIdx != null && !session.confirmed && now - session.firedAt < 8000;
        const p = session.lastPlan;
        session = null;
        plan = null;
        planKey = "";
        if (failed) nativeFailed(p, st);
        return;
      }
      if (!session.confirmed) {
        session.confirmed = true;
        if (session.lastPlan) recordMix(session.lastPlan);
      }
      const q = session.queue;
      if (session.pendingIdx != null && st.item.uri === q[session.pendingIdx]?.uri) {
        session.idx = session.pendingIdx;
        session.pendingIdx = null;
      }
      const cur = q[session.idx];
      if (st.item.uri !== cur?.uri) {
        // Overlap in progress, or a mix that never happened.
        if (session.pendingIdx != null && now - session.firedAt > (session.ov?.durationMs || 0) + 20000) session.pendingIdx = null;
        return;
      }
      if (session.pendingIdx != null) return; // fired, waiting for the overlap to reach the new song

      const next = q[session.idx + 1];
      ensurePlan(cur, next, session.idx + 1, st, true);
      const pos = posOf(st);
      if (settings.enabled && plan?.mode === "native" && plan.from.uri === cur.uri && !st.isPaused &&
          pos >= plan.triggerAt && pos < plan.ov.startAMs - 250) {
        fire(st, plan);
        return;
      }
      // No mix will happen for this song: leave automix mode right at the song boundary.
      if (pos >= (st.duration || Infinity) - 350) {
        if (next && mixable(next)) handBack(next, 0);
        else handBack(cur, pos);
      }
      return;
    }

    if (previewActive()) return; // Spotify's own mix editor is previewing; stay out of it

    const cur = ref(st.item);
    ensurePlan(cur, ref(st.nextItems?.[0]), 1, st, false);
    if (!settings.enabled || !plan || st.isPaused || plan.from.uri !== cur.uri) return;
    if (st.nextItems?.[0]?.uid !== plan.to.uid) {
      planKey = "";
      return;
    }
    const pos = posOf(st);
    if (plan.mode === "fade") {
      if (pos >= plan.fadeStart && pos < plan.cutAt - 300) startFade(plan);
      return;
    }
    if (pos >= plan.triggerAt && pos < plan.ov.startAMs - 250) fire(st, plan);
  }

  startClock(tick, 50);

  // ---------------------------------------------------------------- UI

  const ICON = `<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5a.75.75 0 0 1 .75-.75c3.2 0 5.03 2.27 6.25 4.6 1.22-2.33 3.05-4.6 6.25-4.6a.75.75 0 0 1 0 1.5c-2.53 0-3.97 1.9-5.4 4.75 1.43 2.85 2.87 4.75 5.4 4.75a.75.75 0 0 1 0 1.5c-3.2 0-5.03-2.27-6.25-4.6-1.22 2.33-3.05 4.6-6.25 4.6a.75.75 0 0 1 0-1.5c2.53 0 3.97-1.9 5.4-4.75C5.72 6.15 4.28 4.25 1.75 4.25A.75.75 0 0 1 1 3.5z"/></svg>`;
  const button = new S.Playbar.Button("DJ Mix", ICON, openPanel, false, settings.enabled);

  function tempoLabel(ov) {
    if (!ov?.isBeatmatched) return "";
    const pct = ov.speedB && Math.abs(ov.speedB - 1) > 0.001 ? ` (${ov.speedB > 1 ? "+" : ""}${((ov.speedB - 1) * 100).toFixed(1)}% tempo)` : "";
    return ` · beat-matched${pct}`;
  }
  function describe(ov) {
    if (!ov) return "";
    const bits = [];
    if (ov.durationBars) bits.push(`${ov.durationBars} bars`);
    bits.push(`${(ov.durationMs / 1000).toFixed(1)}s overlap`);
    if (ov.isBeatmatched) {
      bits.push(`beat-matched ${Math.round(ov.bpmA)}→${Math.round(ov.bpmB)} BPM`);
      if (ov.speedB && Math.abs(ov.speedB - 1) > 0.001) bits.push(`${ov.speedB > 1 ? "+" : ""}${((ov.speedB - 1) * 100).toFixed(1)}% tempo`);
    } else bits.push("crossfade");
    if (ov.startBMs > 1000) bits.push(`enters at ${fmt(ov.startBMs)}`);
    return bits.join(" · ");
  }
  function describePlan(p) {
    if (!p) return "";
    if (p.mode !== "fade") return describe(p.ov);
    const bits = [`${((p.cutAt - p.fadeStart) / 1000).toFixed(1)}s smooth fade`];
    bits.push(p.ov ? "at Spotify's mix point" : "at the end of the song");
    if (p.entryB > 0) bits.push(`next song starts at ${fmt(p.entryB)}`);
    return bits.join(" · ");
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const mixing = () => session?.pendingIdx != null || !!fade;
  /** The plan for the song that's playing right now, if any. */
  const livePlan = (st = state()) => (plan && st?.item && plan.from.uri === st.item.uri ? plan : null);

  function statusLines() {
    if (!settings.enabled) return ["DJ Mix is off", session ? "Finishing the current song in mix mode" : ""];
    if (fade) {
      const verb = fade.phase === "out" ? "Fading into" : "Bringing in";
      return [`${verb} ${fade.p.to.name}…`, describePlan(fade.p)];
    }
    if (mixing()) {
      const to = session.queue[session.pendingIdx];
      return [`Mixing into ${to?.name}…`, describe(session.ov)];
    }
    const p = livePlan();
    if (p) {
      const left = mixAt(p) - posOf(state());
      const verb = p.mode === "fade" ? "Next fade" : "Next mix";
      return [`${verb} → ${p.to.name} at ${fmt(mixAt(p))}${left > 0 ? ` (in ${fmt(left)})` : ""}`, describePlan(p)];
    }
    return [lastReason || "Waiting for the next song…", ""];
  }

  // ---------------------------------------------------------------- actions

  function setEnabled(on) {
    settings.enabled = on;
    saveSettings();
    button.active = on;
    if (!on) endFade("cancel");
    paintMarker();
  }
  /** A setting changed which mixes are allowed: drop the current plan so it gets re-checked. */
  function replan() {
    if (busy || mixing()) return;
    plan = null;
    planKey = "";
  }
  /** Jump to a few seconds before the next mix point so you hear the blend right away. */
  function mixNow() {
    const st = state();
    const p = livePlan(st);
    if (!settings.enabled || !p || mixing() || busy) return false;
    const target = Math.max(0, mixAt(p) - 4000);
    if (posOf(st) >= target) return false;
    A.seekTo(target); // goes through our hand-back when in automix mode
    return true;
  }
  /** Let the current song end normally instead of mixing, just this once. */
  function skipMix() {
    const p = livePlan();
    if (!p || mixing()) return false;
    skippedKey = p.key;
    plan = null; // planKey stays the same, so this pair isn't planned again
    lastReason = `Skipping this mix; ${p.to.name ?? "the next song"} plays normally`;
    paintMarker();
    return true;
  }
  function unskipMix() {
    skippedKey = "";
    replan();
  }

  // ---------------------------------------------------------------- seek-bar marker
  // A glowing zone on Spotify's progress bar: where the next mix starts and how long the overlap / fade lasts.

  const style = document.createElement("style");
  style.textContent = `
    .djmix-marker { position:absolute; top:50%; height:12px; transform:translateY(-50%); pointer-events:none; z-index:2;
      border-radius:3px; min-width:3px; border-left:2px solid #1ed760;
      background:linear-gradient(90deg, rgba(30,215,96,.55), rgba(30,215,96,.12));
      box-shadow:0 0 8px rgba(30,215,96,.6); animation:djmix-glow 1.6s ease-in-out infinite; }
    .djmix-marker.djmix-fade { border-left-color:#4cc3ff;
      background:linear-gradient(90deg, rgba(76,195,255,.55), rgba(76,195,255,.08)); box-shadow:0 0 8px rgba(76,195,255,.6); }
    @keyframes djmix-glow { 50% { box-shadow:0 0 14px rgba(30,215,96,.95); } }
  `;
  document.head.appendChild(style);

  const BAR_SELECTORS = [
    '[data-testid="playback-progressbar"] [data-testid="progress-bar"]',
    ".playback-bar [data-testid='progress-bar']",
    ".playback-bar .progress-bar",
    '[data-testid="playback-progressbar"]',
  ];
  const findBar = () => {
    for (const sel of BAR_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };
  let marker = null;
  function paintMarker() {
    const st = state();
    const p = livePlan(st);
    const dur = st?.duration;
    const bar = settings.marker && settings.enabled && p && dur > 0 && !mixing() ? findBar() : null;
    if (!bar) {
      marker?.remove();
      marker = null;
      return;
    }
    if (!marker || marker.parentElement !== bar) {
      marker?.remove();
      marker = document.createElement("div");
      marker.className = "djmix-marker";
      if (getComputedStyle(bar).position === "static") bar.style.position = "relative";
      bar.appendChild(marker);
    }
    const start = Math.min(mixAt(p), dur);
    const len = Math.min(mixLen(p), dur - start);
    marker.classList.toggle("djmix-fade", p.mode === "fade");
    marker.style.left = `${(start / dur) * 100}%`;
    marker.style.width = `${(len / dur) * 100}%`;
    marker.title = `DJ Mix ${p.mode === "fade" ? "fade" : "mix"} → ${p.to.name} at ${fmt(start)}`;
  }
  setInterval(paintMarker, 500);

  // ---------------------------------------------------------------- keyboard shortcut

  const onShortcut = (e) => {
    e?.preventDefault?.();
    setEnabled(!settings.enabled);
    S.showNotification(settings.enabled ? "🎧 DJ Mix on" : "DJ Mix off");
  };
  try {
    if (typeof S.Mousetrap?.bind === "function") S.Mousetrap.bind("ctrl+alt+d", onShortcut);
    else S.Keyboard?.registerShortcut?.({ key: "d", ctrl: true, alt: true }, onShortcut);
  } catch (e) {
    log("could not register keyboard shortcut", e);
  }

  // ---------------------------------------------------------------- panel

  function historyHTML() {
    if (!history.length) return `<li class="djmix-empty">No mixes yet. They'll show up here as they happen.</li>`;
    return history
      .map((h) => {
        const meta = h.kind === "fade"
          ? `smooth fade${h.fadeSec ? ` ${h.fadeSec}s` : ""}`
          : h.beat ? `${h.bpmA ?? "?"}→${h.bpmB ?? "?"} BPM${h.tempo ? ` · ${signedPct(h.tempo)}` : ""}` : "crossfade";
        const when = new Date(h.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return `<li><span class="djmix-h-songs"><span>${esc(h.from)}</span> → <b>${esc(h.to)}</b></span>
          <span class="djmix-h-meta">${esc(meta)} · ${when}</span></li>`;
      })
      .join("");
  }
  function statsLine() {
    if (!stats.mixes) return "";
    const fades = stats.fades || 0;
    const native = stats.mixes - fades;
    const bits = [`All time: ${stats.mixes} ${stats.mixes === 1 ? "mix" : "mixes"}`];
    if (native > 0) {
      bits.push(`${Math.round((stats.beatmatched / native) * 100)}% beat-matched`);
      if (stats.beatmatched) bits.push(`avg tempo shift ${(stats.tempoSum / stats.beatmatched).toFixed(1)}%`);
      bits.push(stats.overlapMs >= 60000 ? `${Math.round(stats.overlapMs / 60000)} min of blending` : `${Math.round(stats.overlapMs / 1000)}s of blending`);
    }
    if (fades) bits.push(`${fades} smooth ${fades === 1 ? "fade" : "fades"}`);
    return bits.join(" · ");
  }

  function openPanel() {
    const root = document.createElement("div");
    const checkbox = (key, label) => `
      <div class="djmix-row"><label for="djmix-${key}">${label}</label>
        <input type="checkbox" id="djmix-${key}" data-key="${key}" ${settings[key] ? "checked" : ""}></div>`;
    const select = (key, label, opts) => `
      <div class="djmix-row"><label for="djmix-${key}">${label}</label>
        <select id="djmix-${key}" data-select="${key}">${opts
          .map(([v, t]) => `<option value="${v}" ${String(settings[key]) === String(v) ? "selected" : ""}>${t}</option>`)
          .join("")}</select></div>`;
    root.innerHTML = `
      <style>
        .djmix { display:flex; flex-direction:column; gap:14px; font-size:14px; color:var(--spice-text); min-width:360px; }
        .djmix-status { padding:14px; border-radius:8px; background:var(--spice-highlight, rgba(255,255,255,.07)); }
        .djmix-status b { display:block; font-size:15px; }
        .djmix-status span { display:block; margin-top:4px; opacity:.7; font-size:12px; }
        .djmix-status em { display:block; margin-top:8px; font-style:normal; font-size:11px; opacity:.55; letter-spacing:.02em; }
        .djmix-meter { margin-top:10px; height:4px; border-radius:2px; background:rgba(255,255,255,.1); overflow:hidden; }
        .djmix-meter i { display:block; height:100%; width:0; background:#1ed760; transition:width .25s linear; }
        .djmix-actions { display:flex; gap:8px; }
        .djmix-actions button { flex:1; padding:8px 12px; border-radius:500px; border:1px solid rgba(255,255,255,.25);
          background:transparent; color:inherit; font-weight:700; font-size:13px; cursor:pointer; }
        .djmix-actions button:hover:not(:disabled) { border-color:#1ed760; color:#1ed760; }
        .djmix-actions button:disabled { opacity:.35; cursor:default; }
        .djmix-row { display:flex; align-items:center; justify-content:space-between; gap:16px; }
        .djmix-row input { width:18px; height:18px; accent-color:var(--spice-button, #1db954); }
        .djmix-row select { background:var(--spice-highlight, #333); color:inherit; border:0; border-radius:4px; padding:4px 6px; }
        .djmix-h { font-size:12px; text-transform:uppercase; letter-spacing:.08em; opacity:.6; margin-top:4px; }
        .djmix-hist { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; max-height:190px; overflow:auto; }
        .djmix-hist li { display:flex; flex-direction:column; gap:2px; font-size:13px; }
        .djmix-h-songs span { opacity:.75; }
        .djmix-h-meta, .djmix-stats, .djmix-empty { opacity:.6; font-size:12px; }
        .djmix-note { opacity:.6; font-size:12px; line-height:1.45; }
      </style>
      <div class="djmix">
        <div class="djmix-status"><b data-l1></b><span data-l2></span><div class="djmix-meter"><i data-meter></i></div>
          <em data-engine></em></div>
        <div class="djmix-actions">
          <button data-act="now" title="Jump to just before the mix point">⏩ Mix now</button>
          <button data-act="skip" title="Let this song end normally, just this once">Skip this mix</button>
        </div>
        ${checkbox("enabled", "Mix songs like a DJ <span style='opacity:.5'>(Ctrl+Alt+D)</span>")}
        ${checkbox("notify", "Show a notification on each mix")}
        ${checkbox("marker", "Show the next mix on the seek bar")}
        <div class="djmix-h">Engine</div>
        ${select("engine", "Mix engine", [["auto", "Auto"], ["native", "Beat-match (Premium)"], ["fade", "Smooth fade (any account)"]])}
        ${checkbox("fallbackFade", "Fade songs beat-match can't mix (queue, no transition)")}
        ${select("fadeSec", "Fade length", [[3, "3s"], [6, "6s"], [9, "9s"], [12, "12s"]])}
        ${checkbox("smartEntry", "Start the next song past its quiet intro")}
        <div class="djmix-h">Beat-match filters</div>
        ${checkbox("beatOnly", "Only mix when Spotify can beat-match")}
        ${select("maxTempo", "Largest tempo change allowed", [[0, "Any"], [2, "±2%"], [4, "±4%"], [6, "±6%"], [8, "±8%"]])}
        <div class="djmix-h">Recent mixes</div>
        <ul class="djmix-hist" data-hist></ul>
        <div class="djmix-stats" data-stats></div>
        <div class="djmix-note">Beat-match transitions come from Spotify's own automix engine, which only plays on
          Premium. On Spotify Free, DJ Mix uses a Smooth fade instead: Spotify still picks the mix point and the next
          song's entry point, and DJ Mix fades between them. A true overlap isn't possible there, because the player
          only plays one song at a time.</div>
      </div>`;

    root.querySelectorAll("[data-key]").forEach((input) =>
      input.addEventListener("change", () => {
        const key = input.dataset.key;
        if (key === "enabled") return setEnabled(input.checked);
        settings[key] = input.checked;
        saveSettings();
        if (key !== "notify" && key !== "marker") replan();
        paintMarker();
      })
    );
    root.querySelectorAll("[data-select]").forEach((sel) =>
      sel.addEventListener("change", () => {
        const key = sel.dataset.select;
        settings[key] = key === "engine" ? sel.value : +sel.value || 0;
        if (key === "engine" && sel.value === "auto" && nativeState.broken && !isFree()) {
          nativeState.broken = false; // picking Auto again retries beat-match
          saveJSON(NATIVE_KEY, nativeState);
        }
        saveSettings();
        replan();
      })
    );
    const btnNow = root.querySelector('[data-act="now"]');
    const btnSkip = root.querySelector('[data-act="skip"]');
    const canUnskip = () => !!skippedKey && skippedKey === planKey && !livePlan();
    btnNow.addEventListener("click", () => mixNow());
    btnSkip.addEventListener("click", () => (canUnskip() ? unskipMix() : skipMix()));

    const l1 = root.querySelector("[data-l1]"), l2 = root.querySelector("[data-l2]");
    const engineEl = root.querySelector("[data-engine]");
    const meter = root.querySelector("[data-meter]");
    const histEl = root.querySelector("[data-hist]"), statsEl = root.querySelector("[data-stats]");
    const enabledBox = root.querySelector("#djmix-enabled");
    let shownHistory = -1;
    const refresh = () => {
      if (!root.isConnected && root.dataset.shown) return clearInterval(timer);
      if (root.isConnected) root.dataset.shown = "1";
      const st = state();
      const p = livePlan(st);
      const [a, b] = statusLines();
      l1.textContent = a;
      l2.textContent = b;
      engineEl.textContent = `Engine: ${engineLabel()}`;
      enabledBox.checked = settings.enabled; // the shortcut can flip it while the panel is open
      meter.style.width = p ? `${Math.min(100, (posOf(st) / mixAt(p)) * 100)}%` : mixing() ? "100%" : "0%";
      btnNow.disabled = !settings.enabled || !p || mixing() || posOf(st) >= mixAt(p) - 4000;
      const unskip = canUnskip();
      btnSkip.textContent = unskip ? "Undo skip" : "Skip this mix";
      btnSkip.disabled = !(p || unskip) || mixing();
      const stamp = history.length ? history[0].at : 0;
      if (stamp !== shownHistory) {
        shownHistory = stamp;
        histEl.innerHTML = historyHTML();
        statsEl.textContent = statsLine();
      }
    };
    const timer = setInterval(refresh, 250);
    refresh();
    S.PopupModal.display({ title: "DJ Mix", content: root, isLarge: false });
  }

  window.__djmix = {
    get plan() { return plan; },
    get session() { return session; },
    get fade() { return fade; },
    get account() { return account; },
    get engine() { return engineLabel(); },
    nativeState,
    settings,
    history,
    stats,
    mixNow,
    skipMix,
  };
  log(`ready · engine: ${engineLabel()}`);
})();
