// Sidescript for varslingssiden. Lastes som <script type="module">, så alt her har
// sitt eget scope. felles.ts lastes som klassisk script foran, så `krevEl`,
// `feilmelding` og `maskinportenToken` er globale her.
export {};

const backendBase = "http://localhost:8080";
const fiksBase = "http://localhost:8081";

/*
 * To maskintokener, fordi de dekker to fullmakter.
 *
 * `ks:innbyggerdialog:varsling` mot sandbox-backend utløser jobben;
 * `ks:fiks:varsel` mot fiks-simulator leser utboksen. Et token for den ene er
 * avvist av den andre - det er audience-begrensning, og det er poenget.
 *
 * At en *side* henter dem er en sandkasseforenkling: digdir-mock validerer
 * assertionen på form og ikke på signatur. I drift er det kommunens fagsystem som
 * gjør dette, aldri en nettleser. Se kommentaren over `maskinportenToken` i
 * felles.ts.
 */
const VARSLINGSSCOPE = "ks:innbyggerdialog:varsling";
const FIKSSCOPE = "ks:fiks:varsel";

type Utsending = {
  personId: string;
  status: string;
  kanal?: string;
  grunn?: string;
  varseltype: string;
  /** Skjøten mot Fiks' utboks. Settes først når et forsøk faktisk er gjort. */
  varselId?: string;
  tidspunkt: string;
};

type Kjoereresultat = {
  hjemmel?: Hjemmel;
  torrkjoer: boolean;
  vurdert: number;
  alleredeSendt: number;
  perKanal: Record<string, number>;
  feilet: number;
  utsendinger: Utsending[];
};

type Varsel = { varselId: string; kanal: string; tekst: string; type: string; opprettet: string };

type Hjemmel = { behandlingsgrunnlag: string; suppleringsgrunnlag: string; formaal: string };

/**
 * Hjemmelen kommer fra tjenesten og skrives ikke i markupen.
 *
 * Sto den to steder kunne de si forskjellige ting, og det ene av dem er det som
 * havner i revisjonsloggen. Siden skal vise det loggen faktisk får.
 */
function visHjemmel(hjemmel: Hjemmel | undefined): void {
  if (!hjemmel) return;
  krevEl("behandlingsgrunnlag").textContent = hjemmel.behandlingsgrunnlag;
  krevEl("suppleringsgrunnlag").textContent = hjemmel.suppleringsgrunnlag;
}

/**
 * Hvorfor et varsel ikke gikk, på norsk.
 *
 * Kodene er wire og skal ikke oversettes i backend; det er her de blir til noe en
 * saksbehandler leser. Faller tilbake til koden selv framfor til tom streng: en
 * ukjent kode skal være synlig, ikke usynlig.
 */
const GRUNNTEKST: Record<string, string> = {
  reservert: "Reservert mot digital kommunikasjon",
  kan_ikke_varsles: "Ingen varslingsadresse i kontaktregisteret",
  ukjent_i_kontaktregisteret: "Står ikke i kontaktregisteret",
  ingen_kontaktopplysning: "Kan varsles, men har verken telefon eller e-post"
};

const STATUSTEKST: Record<string, string> = {
  planlagt: "Ville fått varsel",
  paabegynt: "Påbegynt",
  sendt: "Sendt",
  ikke_naadd: "Ikke nådd",
  feilet: "Feilet"
};

/**
 * Kanalen et *brev* ville gått på, for de samme personene.
 *
 * Utledet i frontend framfor hentet, fordi den bare er der for å vise kontrasten.
 * Regelen som gjelder bor i `chooseKanal` i fiks-simulator, og den kjøres når det
 * faktisk sendes et brev - dette er en illustrasjon ved siden av, ikke en kopi
 * noen skal handle på. Derfor står den heller ikke i en kolonne som ser autoritativ ut.
 */
function brevkanalFor(grunn: string | undefined): string {
  if (grunn === "reservert") return "Papir";
  if (grunn === "kan_ikke_varsles") return "Papir";
  if (grunn === "ukjent_i_kontaktregisteret") return "Papir, hvis adressen finnes";
  if (grunn === undefined) return "Digital post";
  return "-";
}

function visSpinner(paa: boolean): void {
  krevEl("spinner").hidden = !paa;
  (krevEl("knappTorr") as HTMLButtonElement).disabled = paa;
  (krevEl("knappSend") as HTMLButtonElement).disabled = paa;
}

function visMelding(tekst: string, farge: "info" | "success" | "warning" | "danger"): void {
  const boks = krevEl("melding");
  boks.hidden = false;
  boks.dataset.color = farge;
  boks.textContent = tekst;
}

function tallrute(etikett: string, verdi: string | number): HTMLElement {
  const rute = document.createElement("div");
  rute.className = "v-tall__rute";
  const tall = document.createElement("span");
  tall.className = "v-tall__verdi";
  tall.textContent = String(verdi);
  const navn = document.createElement("span");
  navn.className = "ds-paragraph";
  navn.dataset.size = "sm";
  navn.textContent = etikett;
  rute.append(tall, navn);
  return rute;
}

function renderTall(resultat: Kjoereresultat): void {
  const boks = krevEl("tall");
  boks.hidden = false;
  boks.replaceChildren();
  boks.append(tallrute("kvalifiserer", resultat.vurdert));
  boks.append(tallrute("varslet fra før", resultat.alleredeSendt));
  for (const [kanal, antall] of Object.entries(resultat.perKanal).sort()) {
    boks.append(tallrute(kanal === "INGEN" ? "kunne ikke nås" : `sendt på ${kanal}`, antall));
  }
  if (resultat.feilet > 0) boks.append(tallrute("feilet", resultat.feilet));
}

function celle(rad: HTMLTableRowElement, tekst: string): void {
  const td = document.createElement("td");
  td.textContent = tekst;
  rad.append(td);
}

function renderUtsendinger(utsendinger: Utsending[]): void {
  krevEl("utsendingerSeksjon").hidden = utsendinger.length === 0;
  const kropp = krevEl("utsendinger");
  kropp.replaceChildren();
  for (const rad of utsendinger) {
    const tr = document.createElement("tr");
    celle(tr, rad.personId);

    const status = document.createElement("td");
    const merke = document.createElement("span");
    merke.className = "ds-tag";
    merke.dataset.size = "sm";
    // Farge etter utfall, ikke etter alvor: «ikke nådd» er en opplysning kommunen
    // skal ha, ikke en feil noen har gjort.
    merke.dataset.color = rad.status === "sendt" ? "success"
      : rad.status === "feilet" ? "danger" : "neutral";
    merke.textContent = STATUSTEKST[rad.status] ?? rad.status;
    status.append(merke);
    tr.append(status);

    celle(tr, rad.kanal === "INGEN" ? "-" : (rad.kanal ?? "-"));
    celle(tr, rad.grunn ? (GRUNNTEKST[rad.grunn] ?? rad.grunn) : "-");
    celle(tr, brevkanalFor(rad.grunn));
    kropp.append(tr);
  }
}

/*
 * LOGGEN.
 *
 * To kilder, fordi de vet hver sin halvdel: ledgeren i sandbox-backend vet hvem
 * som ble vurdert og hva utfallet ble, og fiks vet hva det faktisk sto i
 * meldingen. `varselId` er skjøten, og den finnes bare fordi ledgeren lagrer
 * id-en Fiks svarte med.
 *
 * Sammenstillingen skjer her og ikke i backend med vilje: å la sandbox-backend
 * lese Fiks' utboks for å bygge en visning ville lagt en avhengighet inn i
 * motoren for noe bare denne siden trenger.
 */
type Loggrad = Utsending & { tekst?: string; opprettet?: string; navn?: string };

let logg: Loggrad[] = [];
let navnPerPerson = new Map<string, string>();

async function hentNavn(): Promise<void> {
  // Navn framfor person-401 i en operativ logg: en saksbehandler ser navnet, og
  // «hvem fikk brevet» er ikke et spørsmål man svarer på med en id.
  if (navnPerPerson.size > 0) return;
  try {
    const token = await maskinportenToken("sandbox-backend", "ks:innbyggerdialog:les");
    const svar = await fetch(`${backendBase}/api/personer`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!svar.ok) return;
    const personer = await svar.json() as {
      personId: string; navn?: { fornavn?: string; etternavn?: string } }[];
    navnPerPerson = new Map(personer.map((person) => [
      person.personId,
      [person.navn?.fornavn, person.navn?.etternavn].filter(Boolean).join(" ")
    ]));
  } catch {
    // Navn er pynt. Uten dem viser loggen personId, og det er fortsatt en logg.
  }
}

async function hentLogg(): Promise<void> {
  await hentNavn();
  const [ledgerToken, fiksToken] = await Promise.all([
    maskinportenToken("sandbox-backend", VARSLINGSSCOPE),
    maskinportenToken("fiks-simulator", FIKSSCOPE)
  ]);
  const [ledgerSvar, utboksSvar] = await Promise.all([
    fetch(`${backendBase}/api/varsel/seniorsirkel/utsendinger`,
      { headers: { Authorization: `Bearer ${ledgerToken}` } }),
    fetch(`${fiksBase}/fiks/varsler`, { headers: { Authorization: `Bearer ${fiksToken}` } })
  ]);
  if (!ledgerSvar.ok) throw new Error(`Ledgeren svarte ${ledgerSvar.status}.`);
  const ledger = await ledgerSvar.json() as { utsendinger: Utsending[]; hjemmel?: Hjemmel };
  visHjemmel(ledger.hjemmel);

  // Utboksen er best effort: er fiks nede, er loggen fortsatt en logg - den mangler
  // bare teksten. Å la hele siden feile på det ville vært en dårligere byttehandel.
  const tekstPerVarsel = new Map<string, Varsel>();
  if (utboksSvar.ok) {
    const utboks = await utboksSvar.json() as { varsler: Varsel[] };
    for (const varsel of utboks.varsler) tekstPerVarsel.set(varsel.varselId, varsel);
  }

  logg = ledger.utsendinger.map((rad) => {
    const varsel = rad.varselId ? tekstPerVarsel.get(rad.varselId) : undefined;
    return {
      ...rad,
      ...(varsel ? { tekst: varsel.tekst, opprettet: varsel.opprettet } : {}),
      ...(navnPerPerson.get(rad.personId) ? { navn: navnPerPerson.get(rad.personId) } : {})
    };
  });

  fyllPersonfilter();
  renderLogg();
}

/** Bare mottakere som faktisk står i loggen. En tom valgmulighet er en blindvei. */
function fyllPersonfilter(): void {
  const velger = krevEl<HTMLSelectElement>("personfilter");
  const valgt = velger.value;
  const sette = new Map<string, string>();
  for (const rad of logg) {
    sette.set(rad.personId, rad.navn ? `${rad.navn} (${rad.personId})` : rad.personId);
  }
  velger.replaceChildren();
  const alle = document.createElement("option");
  alle.value = "";
  alle.textContent = `Alle mottakere (${sette.size})`;
  velger.append(alle);
  for (const [personId, etikett] of [...sette].sort((a, b) => a[1].localeCompare(b[1], "nb"))) {
    const valg = document.createElement("option");
    valg.value = personId;
    valg.textContent = etikett;
    velger.append(valg);
  }
  if ([...sette.keys()].includes(valgt)) velger.value = valgt;
}

function tidspunktTekst(rad: Loggrad): string {
  const naar = rad.opprettet || rad.tidspunkt;
  if (!naar) return "";
  // Norsk tid, ikke maskinens: en logg som viser UTC lyver for den som leser den.
  return new Date(naar).toLocaleString("nb-NO", { timeZone: "Europe/Oslo" });
}

function merke(tekst: string, farge: string): HTMLElement {
  const merket = document.createElement("span");
  merket.className = "ds-tag";
  merket.dataset.size = "sm";
  merket.dataset.color = farge;
  merket.textContent = tekst;
  return merket;
}

/**
 * Ett loggkort. Egen funksjon og ikke bare inline i renderLogg(), fordi
 * varsel-SMS-veiviserens steg 3 viser nøyaktig det samme kortet, bare
 * forhåndsfiltrert til én person - samme markup ett sted, ikke to.
 */
function byggLoggkort(rad: Loggrad): HTMLElement {
  const kort = document.createElement("article");
  kort.className = "v-logg__rad";

  const hode = document.createElement("div");
  hode.className = "v-logg__hode";
  const hvem = document.createElement("span");
  hvem.className = "ds-heading";
  hvem.dataset.size = "2xs";
  hvem.textContent = rad.navn ? `${rad.navn} (${rad.personId})` : rad.personId;
  const tid = document.createElement("span");
  tid.className = "ds-paragraph v-logg__tid";
  tid.dataset.size = "sm";
  tid.textContent = tidspunktTekst(rad);
  hode.append(hvem, tid);

  const merker = document.createElement("div");
  merker.className = "v-logg__merker";
  merker.append(merke(STATUSTEKST[rad.status] ?? rad.status,
    rad.status === "sendt" ? "success" : rad.status === "feilet" ? "danger" : "neutral"));
  if (rad.kanal && rad.kanal !== "INGEN") merker.append(merke(rad.kanal, "info"));
  merker.append(merke(rad.varseltype, "neutral"));
  if (rad.grunn) {
    const grunn = document.createElement("span");
    grunn.className = "ds-paragraph";
    grunn.dataset.size = "sm";
    grunn.textContent = GRUNNTEKST[rad.grunn] ?? rad.grunn;
    merker.append(grunn);
  }

  kort.append(hode, merker);

  /*
   * Teksten finnes også for dem som ikke ble nådd - Fiks lagrer forsøket, ikke
   * bare leveransen. Men en melding vist som en vanlig boble under «Ikke nådd»
   * leses som at den kom fram, og det er stikk motsatt av det raden sier. Derfor
   * er den merket, dempet, og kalt det den er.
   */
  if (rad.tekst) {
    const levert = rad.kanal !== undefined && rad.kanal !== "INGEN";
    const boble = document.createElement("div");
    boble.className = levert ? "v-sms__boble" : "v-sms__boble v-sms__boble--ulevert";
    if (!levert) {
      const stempel = document.createElement("p");
      stempel.className = "ds-paragraph";
      stempel.dataset.size = "xs";
      stempel.style.margin = "0";
      stempel.style.fontWeight = "600";
      stempel.textContent = "Ikke levert - dette er teksten som ville gått ut";
      boble.append(stempel);
    }
    const tekst = document.createElement("p");
    tekst.className = "ds-paragraph";
    tekst.dataset.variant = "long";
    tekst.style.margin = "0";
    tekst.textContent = rad.tekst;
    const lengde = document.createElement("p");
    lengde.className = "ds-paragraph v-logg__tid";
    lengde.dataset.size = "xs";
    lengde.style.margin = "0";
    lengde.textContent = `${rad.tekst.length} tegn`;
    boble.append(tekst, lengde);
    kort.append(boble);
  }
  return kort;
}

/** Kortene for en radliste, i en tom container med samme tomtekst-idiom som renderLogg(). */
function renderLoggkort(container: HTMLElement, rader: Loggrad[], tomtekst: string): void {
  container.replaceChildren();
  if (rader.length === 0) {
    const tom = document.createElement("p");
    tom.className = "ds-paragraph";
    tom.textContent = tomtekst;
    container.append(tom);
    return;
  }
  for (const rad of rader) container.append(byggLoggkort(rad));
}

function renderLogg(): void {
  const person = krevEl<HTMLSelectElement>("personfilter").value;
  const utfall = krevEl<HTMLSelectElement>("utfallfilter").value;
  const vist = logg.filter((rad) =>
    (!person || rad.personId === person) && (!utfall || rad.status === utfall));

  krevEl("loggSeksjon").hidden = logg.length === 0;
  krevEl("loggtelling").textContent = logg.length === 0
    ? ""
    : `Viser ${vist.length} av ${logg.length} varsler.`;

  renderLoggkort(krevEl("logg"), vist, "Ingen varsler passer filteret.");
}

async function kjoer(torrkjoer: boolean): Promise<void> {
  visSpinner(true);
  try {
    const token = await maskinportenToken("sandbox-backend", VARSLINGSSCOPE);
    const svar = await fetch(
      `${backendBase}/api/varsel/seniorsirkel/kjor${torrkjoer ? "?torrkjor=true" : ""}`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const data = await svar.json();
    if (!svar.ok) throw new Error(data.feil || `Tjenesten svarte ${svar.status}.`);
    const resultat = data as Kjoereresultat;

    visHjemmel(resultat.hjemmel);
    renderTall(resultat);
    renderUtsendinger(resultat.utsendinger);
    if (torrkjoer) {
      visMelding(`Tørrkjøring. ${resultat.vurdert} kvalifiserer, `
        + `${resultat.utsendinger.length} ville fått varsel nå. Ingenting er sendt.`, "info");
    } else if (resultat.utsendinger.length === 0) {
      // Den andre kjøringen er halve poenget: ledgeren gjør at ingen får to.
      visMelding(`Ingenting å sende. Alle ${resultat.alleredeSendt} har fått varselet før.`,
        "success");
    } else {
      const naadd = resultat.utsendinger.filter((rad) => rad.status === "sendt").length;
      visMelding(`Sendt til ${naadd} av ${resultat.utsendinger.length}. `
        + "Resten kunne ikke nås - se hvorfor i tabellen.", "success");
    }
    if (!torrkjoer) await hentLogg();
  } catch (feil) {
    visMelding(feilmelding(feil), "danger");
  } finally {
    visSpinner(false);
  }
}

type Arrangement = {
  tilbudId: string;
  navn: string;
  neste: { dato: string; fraKlokkeslett: string } | null;
};

/**
 * Arrangementene i nedtrekket, med neste gang skrevet ut.
 *
 * Et tilbud uten neste gang blir stående, men merket - det er en opplysning
 * («dette kurset er over») og ikke noe å skjule. Den kan bare ikke velges, siden
 * det ikke finnes noe å minne om.
 */
async function hentArrangementer(): Promise<void> {
  const fraDato = krevEl<HTMLInputElement>("fraDato").value;
  const token = await maskinportenToken("sandbox-backend", VARSLINGSSCOPE);
  const svar = await fetch(
    `${backendBase}/api/varsel/seniorsirkel/arrangementer${fraDato ? `?fraDato=${fraDato}` : ""}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!svar.ok) throw new Error(`Tjenesten svarte ${svar.status}.`);
  const data = await svar.json() as { arrangementer: Arrangement[] };
  const velger = krevEl<HTMLSelectElement>("arrangement");
  const valgt = velger.value;
  velger.replaceChildren();
  for (const rad of data.arrangementer) {
    const valg = document.createElement("option");
    valg.value = rad.tilbudId;
    valg.textContent = rad.neste
      ? `${rad.navn} - ${rad.neste.dato} kl. ${rad.neste.fraKlokkeslett}`
      : `${rad.navn} - ingen neste gang`;
    valg.disabled = rad.neste === null;
    velger.append(valg);
  }
  if ([...velger.options].some((valg) => valg.value === valgt)) velger.value = valgt;
}

async function sendPaaminnelse(): Promise<void> {
  const boks = krevEl("paaminnelsemelding");
  const tilbudId = krevEl<HTMLSelectElement>("arrangement").value;
  const fraDato = krevEl<HTMLInputElement>("fraDato").value;
  if (!tilbudId) return;
  visSpinner(true);
  try {
    const token = await maskinportenToken("sandbox-backend", VARSLINGSSCOPE);
    const svar = await fetch(`${backendBase}/api/varsel/seniorsirkel/paaminnelse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tilbudId, ...(fraDato ? { fraDato } : {}) })
    });
    const data = await svar.json();
    if (!svar.ok) throw new Error(data.feil || `Tjenesten svarte ${svar.status}.`);
    boks.hidden = false;
    if (data.paameldte === 0) {
      // Null påmeldte er ikke en feil. Det er svaret, og det peker på hva man
      // gjør nå: meld noen på i innbyggerportalen først.
      boks.dataset.color = "warning";
      boks.textContent = `Ingen er påmeldt ${data.navn} ennå. `
        + "Meld på en innbygger i innbyggerportalen først.";
    } else {
      boks.dataset.color = "success";
      const sendt = data.utsendinger.filter((rad: Utsending) => rad.status === "sendt").length;
      boks.textContent = `${data.navn}, ${data.neste?.dato ?? "uten dato"}: `
        + `${data.paameldte} påmeldt, ${sendt} varslet`
        + (data.alleredeSendt > 0 ? `, ${data.alleredeSendt} minnet på fra før.` : ".");
    }
    await hentLogg();
  } catch (feil) {
    boks.hidden = false;
    boks.dataset.color = "danger";
    boks.textContent = feilmelding(feil);
  } finally {
    visSpinner(false);
  }
}

// === Faner ============================================================

type Fane = "oversikt" | "sms" | "brev";
const FANEKNAPPER: Record<Fane, string> = {
  oversikt: "oversikt-fane", sms: "sms-fane", brev: "brev-fane"
};
const FANEPANELER: Record<Fane, string> = {
  oversikt: "oversikt-panel", sms: "sms-panel", brev: "brev-panel"
};

let smsInitialisert = false;
let brevInitialisert = false;

function visFane(fane: Fane): void {
  for (const kandidat of Object.keys(FANEKNAPPER) as Fane[]) {
    const knapp = krevEl<HTMLButtonElement>(FANEKNAPPER[kandidat]);
    const valgt = kandidat === fane;
    knapp.setAttribute("aria-selected", String(valgt));
    knapp.tabIndex = valgt ? 0 : -1;
    krevEl(FANEPANELER[kandidat]).hidden = !valgt;
  }
  if (fane === "sms" && !smsInitialisert) {
    smsInitialisert = true;
    void initSmsWizard();
  }
  if (fane === "brev" && !brevInitialisert) {
    brevInitialisert = true;
    void initBrevWizard();
  }
}

// === Delt: kanalen for en demoperson, uten å sende noe ================

type KanalInfo = { personId: string; kanal: string; grunn?: string; kanBrev: boolean };

/**
 * De faste demopersonene begge veiviserne velger mellom - se «Demo-person
 * pool» i planen for hvorfor akkurat disse: 401-408 dekker allerede hver
 * kanal og begge sider av aldersgrensen, så ingen ny testperson trengs.
 */
const DEMO_KANDIDATER = [
  "person-401", "person-402", "person-403", "person-404",
  "person-405", "person-406", "person-407", "person-408"
];

const kanalCache = new Map<string, KanalInfo>();

async function hentKanalinfo(personId: string): Promise<KanalInfo> {
  const cached = kanalCache.get(personId);
  if (cached) return cached;
  const token = await maskinportenToken("sandbox-backend", VARSLINGSSCOPE);
  const svar = await fetch(`${backendBase}/api/varsel/seniorsirkel/kanal/${personId}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!svar.ok) throw new Error(`Kanaloppslaget svarte ${svar.status} for ${personId}.`);
  const data = await svar.json() as KanalInfo;
  kanalCache.set(personId, data);
  return data;
}

async function hentAlleKandidater(): Promise<KanalInfo[]> {
  const rader = await Promise.all(DEMO_KANDIDATER.map(async (personId) => {
    try {
      return await hentKanalinfo(personId);
    } catch {
      return null;
    }
  }));
  return rader.filter((rad): rad is KanalInfo => rad !== null);
}

function fyllValgmuligheter(
  velger: HTMLSelectElement, foersteValg: string, rader: { verdi: string; tekst: string }[]
): void {
  const valgt = velger.value;
  velger.replaceChildren();
  const tom = document.createElement("option");
  tom.value = "";
  tom.textContent = foersteValg;
  velger.append(tom);
  for (const rad of rader) {
    const valg = document.createElement("option");
    valg.value = rad.verdi;
    valg.textContent = rad.tekst;
    velger.append(valg);
  }
  if (rader.some((rad) => rad.verdi === valgt)) velger.value = valgt;
}

// === Delt: smaa DOM-hjelpere for begge veiviserne ======================

function visFeilI(container: HTMLElement, tekst: string): void {
  container.replaceChildren();
  const alert = document.createElement("div");
  alert.className = "ds-alert";
  alert.dataset.color = "danger";
  alert.textContent = tekst;
  container.append(alert);
}

type StegDefinisjon = { nr: number; navn: string };

/**
 * Stegviseren, felles for begge veiviserne. Ikke en designsystem-komponent -
 * bygget av ds-button, siden det ikke finnes noen ds-stepper.
 */
function renderStegviser(
  container: HTMLElement, steg: StegDefinisjon[], gjeldende: number, naadd: number,
  onKlikk: (nr: number) => void
): void {
  container.replaceChildren();
  for (const def of steg) {
    const knapp = document.createElement("button");
    knapp.type = "button";
    knapp.className = "ds-button";
    knapp.dataset.variant = "tertiary";
    knapp.dataset.size = "sm";
    knapp.textContent = `${def.nr}. ${def.navn}`;
    knapp.disabled = def.nr > naadd;
    knapp.dataset.color = def.nr === gjeldende ? "info" : def.nr <= naadd ? "success" : "neutral";
    if (def.nr === gjeldende) knapp.setAttribute("aria-current", "step");
    knapp.addEventListener("click", () => onKlikk(def.nr));
    container.append(knapp);
  }
}

// === Varsel-SMS-veiviseren ==============================================

const SMS_STEG: StegDefinisjon[] = [
  { nr: 1, navn: "Generell SMS" },
  { nr: 2, navn: "Personlig velkomst" },
  { nr: 3, navn: "Påmelding og påminnelser" },
  { nr: 4, navn: "Nytt tilbud" }
];

let smsValgtPersonId = "";
let smsGjeldendeSteg = 1;
let smsNaaddSteg = 1;

async function fyllSmsPersonvelger(): Promise<void> {
  await hentNavn();
  const kandidater = (await hentAlleKandidater()).filter((rad) => rad.kanal !== "INGEN");
  fyllValgmuligheter(
    krevEl<HTMLSelectElement>("smsPerson"),
    kandidater.length === 0 ? "Ingen kandidater" : "Velg…",
    kandidater.map((rad) => ({
      verdi: rad.personId,
      tekst: `${navnPerPerson.get(rad.personId) ?? rad.personId} (${rad.kanal})`
    }))
  );
}

function renderSmsStegviser(): void {
  renderStegviser(krevEl("smsStegviser"), SMS_STEG, smsGjeldendeSteg, smsNaaddSteg, visSmsSteg);
  krevEl("smsStegtekst").textContent =
    `Steg ${smsGjeldendeSteg} av ${SMS_STEG.length}: ${SMS_STEG[smsGjeldendeSteg - 1]!.navn}`;
}

function oppdaterSmsNavigasjon(): void {
  krevEl<HTMLButtonElement>("smsForrige").disabled = smsGjeldendeSteg <= 1;
  krevEl<HTMLButtonElement>("smsNeste").disabled =
    smsGjeldendeSteg >= smsNaaddSteg || smsGjeldendeSteg >= SMS_STEG.length;
}

function visSmsSteg(nr: number): void {
  if (nr < 1 || nr > SMS_STEG.length || nr > smsNaaddSteg) return;
  smsGjeldendeSteg = nr;
  for (let i = 1; i <= SMS_STEG.length; i++) {
    krevEl(`smsSteg${i}`).hidden = i !== nr;
  }
  renderSmsStegviser();
  oppdaterSmsNavigasjon();
  if (nr === 2) void oppdaterSmsGate(2);
  if (nr === 3) void visSmsLogg();
  if (nr === 4) void oppdaterSmsGate(4);
}

function nullstillSmsWizard(): void {
  smsGjeldendeSteg = 1;
  smsNaaddSteg = 1;
  krevEl("smsSteg1Resultat").replaceChildren();
  krevEl("smsSteg2Gate").replaceChildren();
  krevEl("smsSteg3Logg").replaceChildren();
  krevEl("smsSteg4Gate").replaceChildren();
  visSmsSteg(1);
}

function visSmsResultat(container: HTMLElement, data: {
  tekst?: string; advarsel?: string; alleredeSendt?: boolean;
}): void {
  container.replaceChildren();
  if (data.advarsel) {
    const varsel = document.createElement("div");
    varsel.className = "ds-alert";
    varsel.dataset.color = "warning";
    varsel.textContent = data.advarsel;
    container.append(varsel);
  }
  if (data.alleredeSendt) {
    const info = document.createElement("p");
    info.className = "ds-paragraph";
    info.dataset.size = "sm";
    info.textContent = "Allerede sendt til denne personen tidligere i denne demoen.";
    container.append(info);
    return;
  }
  if (data.tekst) {
    const boble = document.createElement("div");
    boble.className = "v-sms__boble";
    const tekst = document.createElement("p");
    tekst.className = "ds-paragraph";
    tekst.dataset.variant = "long";
    tekst.style.margin = "0";
    tekst.textContent = data.tekst;
    boble.append(tekst);
    container.append(boble);
  }
}

async function sendSmsSteg1(): Promise<void> {
  if (!smsValgtPersonId) return;
  const spinner = krevEl("smsSteg1Spinner");
  const resultat = krevEl("smsSteg1Resultat");
  const knapp = krevEl<HTMLButtonElement>("smsSteg1Send");
  knapp.disabled = true;
  spinner.hidden = false;
  try {
    const token = await maskinportenToken("sandbox-backend", VARSLINGSSCOPE);
    const svar = await fetch(`${backendBase}/api/varsel/seniorsirkel/sms/kunngjoring`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ personId: smsValgtPersonId })
    });
    const data = await svar.json();
    if (!svar.ok) throw new Error(data.feil || `Tjenesten svarte ${svar.status}.`);
    visSmsResultat(resultat, data);
    if (smsNaaddSteg < 2) smsNaaddSteg = 2;
    renderSmsStegviser();
    oppdaterSmsNavigasjon();
  } catch (feil) {
    visFeilI(resultat, feilmelding(feil));
  } finally {
    knapp.disabled = false;
    spinner.hidden = true;
  }
}

/**
 * Samtykkeporten foran steg 2 og 4. Sjekkes på nytt hver gang steget vises -
 * en fasilitator kan ha svart ja på innbyggerportalen i mellomtiden - og med
 * en manuell «Sjekk på nytt»-knapp framfor kontinuerlig polling, så demoen er
 * forutsigbar å styre.
 */
async function oppdaterSmsGate(steg: 2 | 4): Promise<void> {
  const container = krevEl(steg === 2 ? "smsSteg2Gate" : "smsSteg4Gate");
  container.replaceChildren();
  const laster = document.createElement("p");
  laster.className = "ds-paragraph";
  laster.dataset.size = "sm";
  laster.textContent = "Sjekker samtykke…";
  container.append(laster);
  try {
    const token = await maskinportenToken("sandbox-backend", "ks:innbyggerdialog:les");
    const svar = await fetch(
      `${backendBase}/api/innbyggerportal/placeholder/samtykke?personId=${smsValgtPersonId}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!svar.ok) throw new Error(`Samtykkeoppslaget svarte ${svar.status}.`);
    const data = await svar.json() as { samtykke: { status: string } | null };
    const status = data.samtykke?.status ?? "VENTER_PAA_SVAR";
    container.replaceChildren();
    if (status === "SAMTYKKET") {
      renderSmsGenerering(container, steg);
      return;
    }
    const alert = document.createElement("div");
    alert.className = "ds-alert";
    if (status === "IKKE_SAMTYKKET" || status === "TRUKKET") {
      alert.dataset.color = "danger";
      alert.textContent = "Personen har svart nei til, eller trukket, samtykket til personlig "
        + "kontakt om seniortilbud. Ingen SMS kan sendes her.";
    } else {
      alert.dataset.color = "warning";
      alert.textContent = "Venter på samtykke. Personen må svare ja på innbyggerportalen først.";
    }
    container.append(alert);
    const sjekk = document.createElement("button");
    sjekk.type = "button";
    sjekk.className = "ds-button";
    sjekk.dataset.variant = "secondary";
    sjekk.dataset.size = "sm";
    sjekk.textContent = "Sjekk på nytt";
    sjekk.addEventListener("click", () => void oppdaterSmsGate(steg));
    container.append(sjekk);
  } catch (feil) {
    visFeilI(container, feilmelding(feil));
  }
}

function renderSmsGenerering(container: HTMLElement, steg: 2 | 4): void {
  const knapper = document.createElement("div");
  knapper.className = "v-knapper";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "ds-button";
  send.textContent = "Generer og send SMS";
  const spinner = document.createElement("span");
  spinner.className = "ds-spinner";
  spinner.hidden = true;
  spinner.dataset.size = "sm";
  knapper.append(send, spinner);
  const resultat = document.createElement("div");
  container.append(knapper, resultat);
  send.addEventListener("click", () => void sendSmsTilbud(steg, send, spinner, resultat));
}

async function sendSmsTilbud(
  steg: 2 | 4, knapp: HTMLButtonElement, spinner: HTMLElement, resultat: HTMLElement
): Promise<void> {
  knapp.disabled = true;
  spinner.hidden = false;
  try {
    const token = await maskinportenToken("sandbox-backend", VARSLINGSSCOPE);
    const svar = await fetch(`${backendBase}/api/varsel/seniorsirkel/sms/tilbud`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        personId: smsValgtPersonId, ramme: steg === 2 ? "forstegang" : "oppfolging"
      })
    });
    const data = await svar.json();
    if (!svar.ok) throw new Error(data.feil || `Tjenesten svarte ${svar.status}.`);
    visSmsResultat(resultat, data);
    const naadd = steg === 2 ? 3 : 4;
    if (smsNaaddSteg < naadd) smsNaaddSteg = naadd;
    renderSmsStegviser();
    oppdaterSmsNavigasjon();
  } catch (feil) {
    visFeilI(resultat, feilmelding(feil));
  } finally {
    knapp.disabled = false;
    spinner.hidden = true;
  }
}

/** Steg 3: rent lesestykke. Ingen ny logikk - viser bekreftelsen og påminnelsen som alt går ut i dag. */
async function visSmsLogg(): Promise<void> {
  const container = krevEl("smsSteg3Logg");
  container.replaceChildren();
  const laster = document.createElement("p");
  laster.className = "ds-paragraph";
  laster.textContent = "Henter logg…";
  container.append(laster);
  try {
    await hentLogg();
    const rader = logg.filter((rad) => rad.personId === smsValgtPersonId
      && (rad.varseltype === "paamelding-bekreftet" || rad.varseltype === "paaminnelse"));
    const navn = navnPerPerson.get(smsValgtPersonId) ?? smsValgtPersonId;
    renderLoggkort(container, rader, `Ingen påmeldinger ennå for ${navn}.`);
    if (smsNaaddSteg < 4) smsNaaddSteg = 4;
    renderSmsStegviser();
    oppdaterSmsNavigasjon();
  } catch (feil) {
    visFeilI(container, feilmelding(feil));
  }
}

async function initSmsWizard(): Promise<void> {
  try {
    await fyllSmsPersonvelger();
  } catch (feil) {
    fyllValgmuligheter(krevEl<HTMLSelectElement>("smsPerson"), feilmelding(feil), []);
  }
}

// === Varsel-brev-veiviseren ==============================================

const BREV_STEG: StegDefinisjon[] = [
  { nr: 1, navn: "Velg mottaker" },
  { nr: 2, navn: "Åpningsbrev" },
  { nr: 3, navn: "Oppfølgingsbrev" }
];

type Brevtype = "aapning" | "oppfolging";

let brevValgtPersonId = "";
let brevGjeldendeSteg = 1;
let brevNaaddSteg = 1;
const brevAvsnittPerType: Partial<Record<Brevtype, string[]>> = {};
const brevPdfUrls: Partial<Record<Brevtype, string>> = {};

async function fyllBrevPersonvelger(): Promise<void> {
  await hentNavn();
  const kandidater = (await hentAlleKandidater()).filter((rad) => rad.kanBrev);
  fyllValgmuligheter(
    krevEl<HTMLSelectElement>("brevPerson"),
    kandidater.length === 0 ? "Ingen mottakere hører til brevsporet" : "Velg…",
    kandidater.map((rad) => ({
      verdi: rad.personId,
      tekst: `${navnPerPerson.get(rad.personId) ?? rad.personId} - `
        + (rad.grunn ? (GRUNNTEKST[rad.grunn] ?? rad.grunn) : "ingen digital kanal")
    }))
  );
}

function renderBrevStegviser(): void {
  renderStegviser(krevEl("brevStegviser"), BREV_STEG, brevGjeldendeSteg, brevNaaddSteg, visBrevSteg);
  krevEl("brevStegtekst").textContent =
    `Steg ${brevGjeldendeSteg} av ${BREV_STEG.length}: ${BREV_STEG[brevGjeldendeSteg - 1]!.navn}`;
}

function oppdaterBrevNavigasjon(): void {
  krevEl<HTMLButtonElement>("brevForrige").disabled = brevGjeldendeSteg <= 1;
  krevEl<HTMLButtonElement>("brevNeste").disabled =
    brevGjeldendeSteg >= brevNaaddSteg || brevGjeldendeSteg >= BREV_STEG.length;
}

function visBrevSteg(nr: number): void {
  if (nr < 1 || nr > BREV_STEG.length || nr > brevNaaddSteg) return;
  brevGjeldendeSteg = nr;
  for (let i = 1; i <= BREV_STEG.length; i++) {
    krevEl(`brevSteg${i}`).hidden = i !== nr;
  }
  renderBrevStegviser();
  oppdaterBrevNavigasjon();
  if (nr === 2) void visBrevInnhold("aapning");
  if (nr === 3) void visBrevInnhold("oppfolging");
}

function nullstillBrevWizard(): void {
  brevGjeldendeSteg = 1;
  brevNaaddSteg = 1;
  delete brevAvsnittPerType.aapning;
  delete brevAvsnittPerType.oppfolging;
  for (const type of ["aapning", "oppfolging"] as const) {
    const url = brevPdfUrls[type];
    if (url) URL.revokeObjectURL(url);
    delete brevPdfUrls[type];
  }
  krevEl("brevUtkastResultat").replaceChildren();
  krevEl("brevSteg2Innhold").replaceChildren();
  krevEl("brevSteg3Innhold").replaceChildren();
  visBrevSteg(1);
}

async function brevLagUtkast(): Promise<void> {
  if (!brevValgtPersonId) return;
  const spinner = krevEl("brevUtkastSpinner");
  const resultat = krevEl("brevUtkastResultat");
  const knapp = krevEl<HTMLButtonElement>("brevLagUtkast");
  knapp.disabled = true;
  spinner.hidden = false;
  resultat.replaceChildren();
  try {
    const token = await maskinportenToken("sandbox-backend", VARSLINGSSCOPE);
    const svarPerType = await Promise.all((["aapning", "oppfolging"] as const).map(async (brevtype) => {
      const svar = await fetch(`${backendBase}/api/varsel/seniorsirkel/brev/utkast`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ personId: brevValgtPersonId, brevtype })
      });
      const data = await svar.json();
      if (!svar.ok) throw new Error(data.feil || `Tjenesten svarte ${svar.status}.`);
      return { brevtype, ...(data as { avsnitt: string[]; advarsel?: string }) };
    }));
    for (const svar of svarPerType) brevAvsnittPerType[svar.brevtype] = svar.avsnitt;
    const p = document.createElement("p");
    p.className = "ds-paragraph";
    p.dataset.size = "sm";
    p.textContent = "Utkast klart for både åpningsbrevet og oppfølgingsbrevet.";
    resultat.append(p);
    const advarsler = svarPerType.map((svar) => svar.advarsel).filter(Boolean);
    if (advarsler.length > 0) {
      const varsel = document.createElement("div");
      varsel.className = "ds-alert";
      varsel.dataset.color = "warning";
      varsel.textContent = advarsler.join(" ");
      resultat.append(varsel);
    }
    if (brevNaaddSteg < 2) brevNaaddSteg = 2;
    renderBrevStegviser();
    oppdaterBrevNavigasjon();
  } catch (feil) {
    visFeilI(resultat, feilmelding(feil));
  } finally {
    knapp.disabled = false;
    spinner.hidden = true;
  }
}

/**
 * PDF-en, hentet med token og vist som en blob-URL.
 *
 * En vanlig <iframe src="..."> kan ikke bære en Authorization-header, og hver
 * rute her krever en. Derfor hentes PDF-en som en autentisert fetch, og det
 * er svaret - ikke en URL til ruten - som blir iframens src.
 */
async function visBrevPdf(container: HTMLElement, brevtype: Brevtype): Promise<void> {
  container.replaceChildren();
  try {
    let url = brevPdfUrls[brevtype];
    if (!url) {
      const token = await maskinportenToken("sandbox-backend", VARSLINGSSCOPE);
      const svar = await fetch(
        `${backendBase}/api/varsel/seniorsirkel/brev/${brevtype}/${brevValgtPersonId}/pdf`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (!svar.ok) throw new Error(`PDF-en svarte ${svar.status}.`);
      url = URL.createObjectURL(await svar.blob());
      brevPdfUrls[brevtype] = url;
    }
    const ramme = document.createElement("div");
    ramme.className = "v-brev__ramme";
    const iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.title = brevtype === "aapning" ? "Åpningsbrevet" : "Oppfølgingsbrevet";
    ramme.append(iframe);
    const lenke = document.createElement("a");
    lenke.className = "ds-link";
    lenke.href = url;
    lenke.target = "_blank";
    lenke.rel = "noopener";
    lenke.textContent = "Åpne i ny fane";
    container.append(ramme, lenke);
  } catch (feil) {
    visFeilI(container, feilmelding(feil));
  }
}

async function hentBrevErSendt(brevtype: Brevtype): Promise<boolean> {
  try {
    const token = await maskinportenToken("sandbox-backend", VARSLINGSSCOPE);
    const svar = await fetch(
      `${backendBase}/api/varsel/seniorsirkel/brev/${brevtype}/${brevValgtPersonId}`,
      { headers: { Authorization: `Bearer ${token}` } });
    return svar.ok;
  } catch {
    return false;
  }
}

/** Steg 2 og 3: avsnittene til gjennomlesning, så «Send brevet» - eller PDF-en, om det alt er sendt. */
async function visBrevInnhold(brevtype: Brevtype): Promise<void> {
  const container = krevEl(brevtype === "aapning" ? "brevSteg2Innhold" : "brevSteg3Innhold");
  container.replaceChildren();
  const avsnitt = brevAvsnittPerType[brevtype];
  if (!avsnitt) {
    const p = document.createElement("p");
    p.className = "ds-paragraph";
    p.textContent = "Lag utkastet i steg 1 først.";
    container.append(p);
    return;
  }
  if (await hentBrevErSendt(brevtype)) {
    await visBrevPdf(container, brevtype);
    return;
  }
  for (const linje of avsnitt) {
    const p = document.createElement("p");
    p.className = "ds-paragraph";
    p.dataset.variant = "long";
    p.textContent = linje;
    container.append(p);
  }
  const knapper = document.createElement("div");
  knapper.className = "v-knapper";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "ds-button";
  send.textContent = "Send brevet";
  const spinner = document.createElement("span");
  spinner.className = "ds-spinner";
  spinner.hidden = true;
  spinner.dataset.size = "sm";
  knapper.append(send, spinner);
  container.append(knapper);
  send.addEventListener("click", () => void sendBrev(brevtype, send, spinner, container));
}

async function sendBrev(
  brevtype: Brevtype, knapp: HTMLButtonElement, spinner: HTMLElement, container: HTMLElement
): Promise<void> {
  const avsnitt = brevAvsnittPerType[brevtype];
  if (!avsnitt) return;
  knapp.disabled = true;
  spinner.hidden = false;
  try {
    const token = await maskinportenToken("sandbox-backend", VARSLINGSSCOPE);
    const svar = await fetch(`${backendBase}/api/varsel/seniorsirkel/brev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ personId: brevValgtPersonId, brevtype, avsnitt })
    });
    const data = await svar.json();
    if (!svar.ok) throw new Error(data.feil || `Tjenesten svarte ${svar.status}.`);
    await visBrevPdf(container, brevtype);
    if (brevNaaddSteg < 3) brevNaaddSteg = 3;
    renderBrevStegviser();
    oppdaterBrevNavigasjon();
  } catch (feil) {
    visFeilI(container, feilmelding(feil));
  } finally {
    knapp.disabled = false;
    spinner.hidden = true;
  }
}

async function initBrevWizard(): Promise<void> {
  try {
    await fyllBrevPersonvelger();
  } catch (feil) {
    fyllValgmuligheter(krevEl<HTMLSelectElement>("brevPerson"), feilmelding(feil), []);
  }
  // brevPerson - mottakervelgeren - står i brevSteg1, som er skjult til dette kjører.
  // Uten det finnes det ingen hendelse som kan åpne den: den eneste andre veien inn
  // er "change" på nettopp det elementet.
  nullstillBrevWizard();
}

async function start(): Promise<void> {
  try {
    await hentArrangementer();
    await hentLogg();
    if (logg.length > 0) {
      visMelding(`Loggen har ${logg.length} varsler fra tidligere kjøringer.`, "info");
    }
  } catch (feil) {
    visMelding(feilmelding(feil), "warning");
  }
}

krevEl("fraDato").addEventListener("change", () => void hentArrangementer());
krevEl("knappPaaminn").addEventListener("click", () => void sendPaaminnelse());
krevEl("personfilter").addEventListener("change", renderLogg);
krevEl("utfallfilter").addEventListener("change", renderLogg);
krevEl("knappTorr").addEventListener("click", () => void kjoer(true));
krevEl("knappSend").addEventListener("click", () => void kjoer(false));
void start();

// --- faner ---
const FANEREKKEFOELGE: Fane[] = ["oversikt", "sms", "brev"];
for (const fane of FANEREKKEFOELGE) {
  const knapp = krevEl<HTMLButtonElement>(FANEKNAPPER[fane]);
  knapp.addEventListener("click", () => visFane(fane));
  knapp.addEventListener("keydown", (hendelse) => {
    if (hendelse.key !== "ArrowLeft" && hendelse.key !== "ArrowRight") return;
    hendelse.preventDefault();
    const indeks = FANEREKKEFOELGE.indexOf(fane);
    const neste = FANEREKKEFOELGE[
      (indeks + (hendelse.key === "ArrowRight" ? 1 : FANEREKKEFOELGE.length - 1)) % FANEREKKEFOELGE.length
    ]!;
    const nesteKnapp = krevEl<HTMLButtonElement>(FANEKNAPPER[neste]);
    nesteKnapp.click();
    nesteKnapp.focus();
  });
}

// --- varsel-sms ---
krevEl<HTMLSelectElement>("smsPerson").addEventListener("change", () => {
  smsValgtPersonId = krevEl<HTMLSelectElement>("smsPerson").value;
  krevEl("smsVeiviser").hidden = !smsValgtPersonId;
  if (smsValgtPersonId) nullstillSmsWizard();
});
krevEl("smsSteg1Send").addEventListener("click", () => void sendSmsSteg1());
krevEl("smsForrige").addEventListener("click", () => visSmsSteg(smsGjeldendeSteg - 1));
krevEl("smsNeste").addEventListener("click", () => visSmsSteg(smsGjeldendeSteg + 1));

// --- varsel-brev ---
krevEl<HTMLSelectElement>("brevPerson").addEventListener("change", () => {
  brevValgtPersonId = krevEl<HTMLSelectElement>("brevPerson").value;
  nullstillBrevWizard();
});
krevEl("brevLagUtkast").addEventListener("click", () => void brevLagUtkast());
krevEl("brevForrige").addEventListener("click", () => visBrevSteg(brevGjeldendeSteg - 1));
krevEl("brevNeste").addEventListener("click", () => visBrevSteg(brevGjeldendeSteg + 1));
