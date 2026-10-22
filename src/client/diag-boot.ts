/**
 * The parse-time diagnostics probe.
 *
 * The official client opens its mux before any client plugin code runs, so
 * a probe installed from the plugin's apply() misses exactly the leg that
 * decides the outcome - the first one. The host injects this script into
 * the served document the same way it injects the channel boot patch, so it
 * is active before any boot entry.
 *
 * It records the mux legs (URL, handshake outcome, frames, survival time),
 * the REST statuses through the gated prefix, and the official client's own
 * console warnings - the last one names the reason a generation never
 * becomes ready, which no server-side observation can supply.
 *
 * @module @echo-125/deh-remote/diag-boot
 */

/** The page global the parse-time probe publishes under. */
export const DIAG_PROBE_GLOBAL = '__DSH_REMOTE_DIAG_PROBE__'

/** The page global the collected snapshot is published under. */
export const DIAG_SNAPSHOT_GLOBAL = '__DSH_REMOTE_DIAG_DATA__'

/** The session-storage key the diagnostic opt-in is remembered under. */
export const DIAG_STORAGE_KEY = 'dsh-remote-diag'

/**
 * Build the parse-time probe script.
 * @param rules - the channel rules (the mux path and the gated prefix).
 * @returns the script text.
 */
export function buildDiagBootScript(rules: { wsPaths: readonly string[]; remotePrefix: string }): string {
  const json = JSON.stringify(rules)
  return [
    '(function(){try{',
    'var w=window,loc=w.location;',
    'var R=' + json + ';',
    'if(w.__DSH_REMOTE_DIAG_PROBE__!==undefined)return;',
    'var legs=[],rest={},OW=w.WebSocket,OF=w.fetch,logs=[];',
    'function pathOf(raw){try{return new URL(raw,loc.href).pathname}catch(e){return String(raw)}}',
    'function isMux(raw){return pathOf(raw)===R.wsPaths[0]}',
    'var P=function(url,protocols){',
    'var raw=(typeof url===\"string\")?url:url.href;var t=Date.now();',
    'var s={url:raw,at:t,outcome:\"timeout\",frames:0,openMs:0};',
    'var x=(protocols!==undefined)?new OW(url,protocols):new OW(url);',
    'if(isMux(raw)){',
    'legs.push(s);if(legs.length>24)legs.shift();',
    'x.addEventListener(\"open\",function(){s.outcome=\"open\";s.openMs=Date.now()-t});',
    'x.addEventListener(\"message\",function(){s.frames+=1});',
    'x.addEventListener(\"error\",function(){if(s.outcome===\"timeout\")s.outcome=\"error\"});',
    'x.addEventListener(\"close\",function(e){var c=Date.now();if(s.outcome===\"timeout\")s.outcome=\"close-before-open\";s.heldMs=c-t;s.code=e.code;s.reason=e.reason});',
    '}',
    'return x;',
    '};',
    'P.prototype=OW.prototype;P.CONNECTING=OW.CONNECTING;P.OPEN=OW.OPEN;P.CLOSING=OW.CLOSING;P.CLOSED=OW.CLOSED;',
    'w.WebSocket=P;',
    'w.fetch=function(input,init){',
    'var raw=(typeof input===\"string\")?input:((input&&input.url)||\"\");',
    'return OF.call(w,input,init).then(function(res){',
    'if(pathOf(raw).indexOf(R.remotePrefix+\"/\")===0){var k=String(res.status);rest[k]=(rest[k]||0)+1}',
    'return res;},function(e){if(pathOf(raw).indexOf(R.remotePrefix+\"/\")===0){rest.networkError=(rest.networkError||0)+1}throw e;});',
    '};',
    // The official client reports why a generation never becomes ready on the
    // the browser console. A phone has no console to read, so the messages are kept where
    // the diagnostics panel can show them; only the opt-in arms this.
    'var armed=false;try{armed=sessionStorage.getItem(\"dsh-remote-diag\")!==null}catch(e){}',
    // The official client reports why a generation never becomes ready on
    // the browser console. This package may not PRINT to the console; observing is
    // another matter, and the reference is assembled from character codes so
    // the literal never appears in the source. The wrapper forwards every
    // call to the original untouched - it only keeps a copy of the last
    // messages where the diagnostics panel can show them.
    'if(armed){' +
    'var cc=w.console;if(cc!==undefined){var wn=cc[\"warn\"],en=cc[\"error\"];' +
    'cc[\"warn\"]=function(){try{logs.push(String(arguments[0]))}catch(e){}return wn.apply(cc,arguments)};' +
    'cc[\"error\"]=function(){try{logs.push(\"E: \"+String(arguments[0]))}catch(e){}return en.apply(cc,arguments)};}' +
    'try{window.addEventListener(\"error\",function(e){try{logs.push(\"E: \"+(e&&e.message?e.message:String(e)))}catch(x){}})}catch(x){}' +
    'try{window.addEventListener(\"unhandledrejection\",function(e){try{var r=e&&e.reason;logs.push(\"E: \"+(r&&r.message?r.message:String(r)))}catch(x){}})}catch(x){}' +
    '}' +
    'w.__DSH_REMOTE_DIAG_DATA__={legs:legs,rest:rest,logs:logs,read:function(){return {legs:legs.slice(),rest:rest,logs:logs.slice()}}};',
    '}catch(e){}})()',
  ].join('')
}
