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

function renderLogg(): void {
  const person = krevEl<HTMLSelectElement>("personfilter").value;
  const utfall = krevEl<HTMLSelectElement>("utfallfilter").value;
  const vist = logg.filter((rad) =>
    (!person || rad.personId === person) && (!utfall || rad.status === utfall));

  krevEl("loggSeksjon").hidden = logg.length === 0;
  krevEl("loggtelling").textContent = logg.length === 0
    ? ""
    : `Viser ${vist.length} av ${logg.length} varsler.`;

  const boks = krevEl("logg");
  boks.replaceChildren();
  if (logg.length > 0 && vist.length === 0) {
    const tom = document.createElement("p");
    tom.className = "ds-paragraph";
    tom.textContent = "Ingen varsler passer filteret.";
    boks.append(tom);
    return;
  }

  for (const rad of vist) {
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
    boks.append(kort);
  }
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
