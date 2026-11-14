// Valuence: holt täglich Kurs, Aktienanzahl und Meldetermine aller Aktien aus Finnhub und legt sie in Supabase ab.
// Läuft in GitHub Actions (Node 20 oder neuer, keine Pakete nötig). Angelegt wird ein Dokument: kurse/daten.
//
// Ablauf: 1) Anmeldung bei Supabase wie in der App  2) Ticker aller Aktien lesen
//         3) je Ticker Kurs, Profil und Meldetermine bei Finnhub holen; nach einer Quartalsmeldung den Kurs davor einfrieren
//         4) Dokument kurse/daten schreiben (nur wenn mindestens ein Kurs ankam)
//
// Einstellungen (Umgebungsvariablen):
//   FINNHUB_KEY, VALUENCE_EMAIL, VALUENCE_PASSWORD   geheim (GitHub Secrets)
//   SUPABASE_URL, SUPABASE_KEY                       öffentlich (die Werte aus der Web-Version, "publishable key")
//   FINNHUB_BASE, PAUSE_MS, RETRY_MS, TIMEOUT_MS     optional (Standard: finnhub.io, 1100 ms, 20000 ms, 30000 ms)
//   HEUTE                                            nur für Tests (Datum in New York, JJJJ-MM-TT)
//
// Aufbau von kurse/daten (Schnittstelle zu Valuence):
//   { quelle, stand, ohneKurs: [Ticker], aktien: { TICKER: {
//       kurs, vortag, datum, anzahl, waehrung,       Kurs in USD, Schluss des Vortags, Handelstag (New York), Aktien in Mio.
//       seit,                                        Tag des ersten Abrufs dieser Aktie; nur Meldungen ab diesem Tag werden eingefroren
//       naechsteMeldung: { datum, zeit } | null,      nächster Termin für Quartalszahlen
//       meldungen: { JJJJ-MM-TT: { zeit, kurs, anzahl, erfasst, pruefen } }   Schlusskurs vor der Meldung, eingefroren
//   } } }
//   zeit: 'bmo' vor Börsenstart, 'amc' nach Börsenschluss, 'dmh' während des Handels, '' unbekannt
//   pruefen: true, wenn der Lauf am richtigen Tag fehlte; dann kann der Kurs die Reaktion auf die Zahlen schon enthalten

const env = process.env;
const fehlt = ['FINNHUB_KEY', 'SUPABASE_URL', 'SUPABASE_KEY', 'VALUENCE_EMAIL', 'VALUENCE_PASSWORD'].filter((k) => !env[k]);
if (fehlt.length) stop('Diese Einstellungen fehlen: ' + fehlt.join(', ') + '. Prüfe die Secrets im Repository und die Datei kurse.yml.');

// Beim Kopieren rutscht leicht ein Leerzeichen oder Zeilenumbruch mit hinein
const FH_KEY = env.FINNHUB_KEY.trim();
const EMAIL = env.VALUENCE_EMAIL.trim();
const PASSWORT = env.VALUENCE_PASSWORD.replace(/[\r\n]+$/, '');

const FH = (env.FINNHUB_BASE || 'https://finnhub.io/api/v1').replace(/\/+$/, '');
const SB = env.SUPABASE_URL.trim().replace(/\/+$/, '');
const SB_KEY = env.SUPABASE_KEY.trim();
const zahlAus = (x, std) => (x !== undefined && x !== '' && isFinite(Number(x)) ? Number(x) : std);
const PAUSE = zahlAus(env.PAUSE_MS, 1100);       // Finnhub gratis: 60 Aufrufe pro Minute
const RETRY = zahlAus(env.RETRY_MS, 20000);      // Wartezeit nach "zu viele Aufrufe" (429) oder Serverfehler
const TIMEOUT = zahlAus(env.TIMEOUT_MS, 30000);  // keine Antwort nach 30 Sekunden = Fehler
const PFAD = 'kurse/daten';
const ZURUECK = 10, VORAUS = 120, BEHALTEN = 120;   // Tage: Meldungen rückwirkend prüfen, Termine vorausschauen, eingefrorene Kurse aufheben

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stop(text) { console.error('FEHLER: ' + text); process.exit(1); }

// ------------------------------------------------------------------ Datum (immer New York, dort läuft die Börse)
function datum(sekunden) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sekunden * 1000));
}
function tagPlus(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function werktageZwischen(a, b) {        // Montag bis Freitag nach a bis einschließlich b
  let n = 0;
  for (let d = tagPlus(a, 1); d <= b && n < 30; d = tagPlus(d, 1)) { const w = new Date(d + 'T12:00:00Z').getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
const HEUTE = /^\d{4}-\d{2}-\d{2}$/.test(env.HEUTE || '') ? env.HEUTE : datum(Date.now() / 1000);
const zahl = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
const zeitVon = (h) => (h === 'bmo' || h === 'amc' || h === 'dmh' ? h : '');

// ------------------------------------------------------------------ Supabase
async function supabase(methode, pfad, token, body, kopf) {
  const res = await fetch(SB + pfad, {
    method: methode,
    headers: Object.assign({ apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, kopf || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT)
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}

async function anmelden() {
  let res;
  try {
    res = await fetch(SB + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORT }),
      signal: AbortSignal.timeout(TIMEOUT)
    });
  } catch (e) { stop('Supabase nicht erreichbar (' + e.message + '). Ist das Projekt pausiert? Im Supabase-Dashboard prüfen.'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) stop('Anmeldung bei Supabase fehlgeschlagen (' + res.status + '). E-Mail und Passwort in den Secrets prüfen.');
  return { token: j.access_token, uid: j.user && j.user.id };
}

// Alle Aktien-Dokumente seitenweise lesen; nur Ticker und Beispiel-Markierung
async function tickerLesen(token) {
  const out = [];
  for (let off = 0; ; ) {
    const q = '/rest/v1/valuence_docs?select=path,ticker:data->v->>Ticker,bsp:data->>bsp&path=like.' + encodeURIComponent('aktien/*') +
      '&order=path.asc&limit=1000&offset=' + off;
    const rows = await supabase('GET', q, token);
    if (!rows || !rows.length) break;
    rows.forEach((r) => out.push(r));
    off += rows.length;
  }
  const gesehen = new Set(), liste = [];
  out.forEach((r) => {
    const t = String(r.ticker || '').trim();
    if (!t || r.bsp === 'true' || gesehen.has(t)) return;      // ohne Ticker, Beispiel-Aktie oder doppelt
    gesehen.add(t); liste.push(t);
  });
  return liste;
}

// ------------------------------------------------------------------ Finnhub
// Wirft bei Problemen mit einem einzelnen Symbol einen Fehler; bricht nur bei ungültigem Schlüssel (401) den ganzen Lauf ab.
async function finnhub(pfad, params) {
  const url = FH + pfad + '?' + new URLSearchParams(params).toString();
  for (let versuch = 0; ; versuch++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'X-Finnhub-Token': FH_KEY }, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (e) {
      if (versuch < 2) { await sleep(RETRY); continue; }
      throw new Error('keine Antwort von Finnhub');
    }
    if (res.status === 401) stop('Finnhub lehnt den Schlüssel ab (401). FINNHUB_KEY im Secret prüfen.');
    if (res.status === 403) throw new Error('kein Zugriff im Gratis-Plan (403)');
    if (res.status === 429 || res.status >= 500) {
      if (versuch < 3) { await sleep(RETRY); continue; }
      throw new Error('Finnhub ' + res.status);
    }
    if (!res.ok) throw new Error('Finnhub ' + res.status);
    return res.json();
  }
}

// Kurs vor der Meldung einfrieren. Immer der Vortagesschluss (pc) eines Handelstags, nie ein nachbörslicher Kurs:
//   vor Börsenstart / während des Handels / unbekannt: am Meldetag selbst ist pc der Schluss davor
//   nach Börsenschluss: am folgenden Handelstag ist pc der Schluss des Meldetags
// handelstag = Datum des letzten Kurses; fehlte der Lauf am richtigen Tag, wird trotzdem eingefroren, aber mit pruefen: true
function einfrieren(termin, e) {
  if (!zahl(e.vortag) || e.vortag <= 0) return null;
  const zeit = zeitVon(termin.hour), tag = e.datum;
  let richtig;
  if (zeit === 'amc') {
    if (termin.date >= tag) return null;                 // erst am nächsten Handelstag
    richtig = werktageZwischen(termin.date, tag) === 1;
  } else {
    if (termin.date > tag) return null;                  // Meldetag noch nicht gehandelt
    richtig = termin.date === tag;
  }
  return { zeit, kurs: e.vortag, anzahl: e.anzahl, erfasst: HEUTE, pruefen: !richtig };
}

function aufheben(meldungen) {
  const out = {}, grenze = tagPlus(HEUTE, -BEHALTEN);
  Object.keys(meldungen || {}).forEach((d) => { if (d >= grenze) out[d] = meldungen[d]; });
  return out;
}

const kalenderFehler = {}, eingefroren = [], zuPruefen = [];

async function einLauf(ticker, vorher) {
  const sym = ticker.toUpperCase();
  let q;
  try { q = await finnhub('/quote', { symbol: sym }); } finally { await sleep(PAUSE); }
  const kurs = zahl(q && q.c);
  if (!kurs || kurs <= 0 || !zahl(q.t) || q.t <= 0) throw new Error('Finnhub kennt das Symbol nicht');   // dann kommen nur Nullen
  let p = {};
  try { p = (await finnhub('/stock/profile2', { symbol: sym })) || {}; }
  catch (e) { console.log('::warning::' + ticker + ': Aktienanzahl nicht abrufbar (' + e.message + ')'); }
  finally { await sleep(PAUSE); }
  const anzahl = zahl(p.shareOutstanding);
  const e = {
    kurs, vortag: zahl(q.pc), datum: datum(q.t),
    anzahl: anzahl && anzahl > 0 ? anzahl : null,
    waehrung: typeof p.currency === 'string' ? p.currency : null,
    seit: (vorher && vorher.seit) || HEUTE,
    naechsteMeldung: (vorher && vorher.naechsteMeldung) || null,
    // Eintrag der ersten Skript-Fassung (ohne „seit“): ihre eingefrorenen Kurse können Meldungen vor der Beobachtung betreffen, sie entfallen
    meldungen: vorher && !vorher.seit ? {} : aufheben(vorher && vorher.meldungen)
  };

  // Meldetermine: vergangene Tage prüfen (Kurs einfrieren), nächsten Termin merken
  let termine = null;
  try {
    const k = await finnhub('/calendar/earnings', { symbol: sym, from: tagPlus(HEUTE, -ZURUECK), to: tagPlus(HEUTE, VORAUS) });
    termine = ((k && k.earningsCalendar) || [])
      .filter((x) => x && String(x.symbol || '').toUpperCase() === sym && /^\d{4}-\d{2}-\d{2}$/.test(x.date || ''))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  } catch (err) { (kalenderFehler[err.message] || (kalenderFehler[err.message] = [])).push(ticker); }
  finally { await sleep(PAUSE); }
  if (termine) {
    const n = termine.find((x) => x.date >= HEUTE);
    e.naechsteMeldung = n ? { datum: n.date, zeit: zeitVon(n.hour) } : null;
    // Nur Meldungen, seit die Aktie beobachtet wird: der Stand in Valuence kann bei älteren schon die neuen Zahlen enthalten.
    // Nach Börsenschluss am ersten Tag zählt noch (der Kurs davor ist der Schluss dieses Tages), vor Börsenstart nicht mehr.
    termine.forEach((x) => {
      if (e.meldungen[x.date] || x.date < tagPlus(HEUTE, -ZURUECK)) return;
      if (zeitVon(x.hour) === 'amc' ? x.date < e.seit : x.date <= e.seit) return;
      const f = einfrieren(x, e);
      if (!f) return;
      e.meldungen[x.date] = f;
      eingefroren.push(ticker + ' (' + x.date + ')');
      if (f.pruefen) zuPruefen.push(ticker + ' (' + x.date + ')');
    });
  }
  return e;
}

// ------------------------------------------------------------------ Ablauf
const { token, uid } = await anmelden();
if (!uid) stop('Die Anmeldung lieferte keine Benutzer-ID.');
const tickers = await tickerLesen(token);
console.log(tickers.length + ' Ticker in Valuence gefunden.');
if (!tickers.length) { console.log('Nichts zu tun.'); process.exit(0); }

let alt = {};
try {
  const rows = await supabase('GET', '/rest/v1/valuence_docs?select=data&path=eq.' + encodeURIComponent(PFAD), token);
  if (rows && rows[0] && rows[0].data && rows[0].data.aktien) alt = rows[0].data.aktien;
} catch (e) { console.log('Hinweis: früheres Dokument nicht lesbar (' + e.message + ').'); }

const neu = {}, ohneKurs = [], ohneAnzahl = [], uebernommen = [], gruende = {};
for (const t of tickers) {
  try {
    const r = await einLauf(t, alt[t]);
    neu[t] = r;
    if (r.anzahl === null) ohneAnzahl.push(t);
  } catch (e) {
    ohneKurs.push(t);
    (gruende[e.message] || (gruende[e.message] = [])).push(t);
    if (alt[t]) { neu[t] = alt[t]; uebernommen.push(t); }          // alter Wert bleibt, sein Datum zeigt das Alter
  }
}

const frisch = tickers.length - ohneKurs.length;
console.log(frisch + ' von ' + tickers.length + ' Kursen aktualisiert.');
Object.keys(gruende).forEach((g) => console.log('::warning::Ohne Kurs (' + g + '): ' + gruende[g].join(', ')));
if (ohneAnzahl.length) console.log('::warning::Ohne Aktienanzahl: ' + ohneAnzahl.join(', '));
if (uebernommen.length) console.log('Alter Wert übernommen für: ' + uebernommen.join(', '));
Object.keys(kalenderFehler).forEach((g) => console.log('::warning::Meldetermine nicht abrufbar (' + g + '): ' + kalenderFehler[g].join(', ')));
if (eingefroren.length) console.log('Kurs vor der Quartalsmeldung eingefroren: ' + eingefroren.join(', '));
if (zuPruefen.length) console.log('::warning::Lauf am Meldetag fehlte, eingefrorenen Kurs prüfen: ' + zuPruefen.join(', '));
if (!frisch) stop('Kein einziger Kurs kam an (' + Object.keys(gruende).join('; ') + '). Das Dokument bleibt unverändert.');

await supabase('POST', '/rest/v1/valuence_docs?on_conflict=user_id,path', token,
  [{ user_id: uid, path: PFAD, data: { quelle: 'Finnhub', stand: new Date().toISOString(), aktien: neu, ohneKurs }, ts: Date.now() }],
  { Prefer: 'resolution=merge-duplicates,return=minimal' });
console.log('Gespeichert: ' + PFAD + ' mit ' + Object.keys(neu).length + ' Aktien.');
