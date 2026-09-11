export {};

const backendBase = "http://localhost:8080";

const PORTAL_ENDPOINTS = {
  meg: "/api/innbyggerportal/placeholder/meg",
  preferanser: "/api/innbyggerportal/placeholder/preferanser",
  tilbud: "/api/innbyggerportal/placeholder/tilbud",
  kontaktinfo: "/api/innbyggerportal/placeholder/kontaktinfo",
  registreringer: "/api/innbyggerportal/placeholder/registreringer",
  samtykke: "/api/innbyggerportal/placeholder/samtykke"
} as const;

type Portalperson = Person & {
  foedselsdato: string;
  bostedsadresse?: { kommune?: string | null; kommunenummer?: string | null } | null;
};

type Tidspunkt = {
  dato?: string;
  ukedager?: string[];
  fraKlokkeslett: string;
  tilKlokkeslett?: string;
};

/**
 * Én skåret rad, slik backend leverer den.
 *
 * `begrunnelseskoder` er hele grunnen til at kortet kan si hvorfor det står der.
 * Kodene er skåringens, ikke portalens - se seniorsirkel.ts.
 */
type Portaltilbud = {
  aktivitetId: string;
  tilbudId: string;
  navn: string;
  kategori: string;
  beskrivelse: string;
  tilbyder: string;
  status: string;
  score: number | null;
  begrunnelseskoder: string[];
  tilbudsnavn?: string;
  former: string[];
  tilrettelegging: string[];
  tidspunkter: Tidspunkt[];
  steder: { navn: string; adresse?: string; poststed?: string }[];
  pris?: { type: string; beloepKr?: number; annetBeloepKr?: number; beskrivelse?: string };
  paameldingKreves: boolean;
  kontakt: Record<string, unknown>;
  tilgjengelighet?: { rullestol?: boolean; teleslynge?: boolean };
};

type Portalvisning = {
  alder: number;
  portalTilgjengelig: boolean;
  aldersgrense: number;
  kommunenavn: string;
  kommunenummer: string;
  antallVurdert: number;
  anbefalte: Portaltilbud[];
  andre: Portaltilbud[];
  utelukkede: Portaltilbud[];
  valgtTilbud: Portaltilbud | null;
  preferanserValgt: boolean;
};

type Portalpreferanser = {
  ferdigstilt: boolean;
  grupper: string[];
  rullestol?: boolean;
  teleslynge?: boolean;
  tilgjengeligeGrupper: { verdi: string; label: string }[];
};

/** Samtykket til personlig kontakt om seniortilbud - se seniorsirkelsamtykke.ts. `null` når hun aldri har blitt spurt. */
type Samtykke = { samtykkeId: string; status: string } | null;

type Kontaktinfo = {
  epost?: { adresse?: string } | null;
  tlf?: { nummer?: string } | null;
};

type Portalregistrering = {
  registreringId: string;
  aktivitetId: string;
  tilbudId: string;
  navn: string;
  status: "MOTTATT";
  opprettet: string;
};

type Bekreftelse = {
  tilbudId: string;
  kanal?: "SMS" | "EPOST" | "INGEN";
  grunn?: string;
};

type Registreringsrespons = {
  registreringer: Portalregistrering[];
  bekreftelser?: Bekreftelse[];
  sporingsId?: string;
};

const statusEl = krevEl("status");
const introEl = krevEl("intro");
const portalfanerEl = krevEl("portalfaner");
const aktiviteterFane = krevEl<HTMLButtonElement>("aktiviteter-fane");
const paameldingerFane = krevEl<HTMLButtonElement>("paameldinger-fane");
const aktiviteterPanelEl = krevEl("aktiviteter-panel");
const paameldingerPanelEl = krevEl("paameldinger-panel");
const paameldingerEl = krevEl("paameldinger");
const ingenPaameldingerEl = krevEl("ingenPaameldinger");
const samtykkeseksjonEl = krevEl("samtykkeseksjon");
const samtykkevalgEl = krevEl("samtykkevalg");
const samtykkefeilEl = krevEl("samtykkefeil");
const lagreSamtykkeKnapp = krevEl<HTMLButtonElement>("lagreSamtykke");
const samtykkestatusLinjeEl = krevEl("samtykkestatusLinje");
const trekkSamtykkeKnapp = krevEl<HTMLButtonElement>("trekkSamtykke");
const preferanseseksjonEl = krevEl("preferanseseksjon");
const preferansevalgEl = krevEl("preferansevalg");
const tilretteleggingsvalgEl = krevEl("tilretteleggingsvalg");
const preferansefeilEl = krevEl("preferansefeil");
const lagrePreferanserKnapp = krevEl<HTMLButtonElement>("lagrePreferanser");
const avbrytPreferanserKnapp = krevEl<HTMLButtonElement>("avbrytPreferanser");
const tilbudsseksjonEl = krevEl("tilbudsseksjon");
const tilbudEl = krevEl("tilbud");
const andretilbudsseksjonEl = krevEl("andretilbudsseksjon");
const andretilbudEl = krevEl("andretilbud");
const utelukketseksjonEl = krevEl("utelukketseksjon");
const utelukketEl = krevEl("utelukket");
const aktivitetsdetaljseksjonEl = krevEl("aktivitetsdetaljseksjon");
const tilbakeLenkeEl = krevEl<HTMLAnchorElement>("tilbakeLenke");
const detaljKategoriEl = krevEl("detaljKategori");
const detaljTittelEl = krevEl("detaljTittel");
const detaljGrunnerEl = krevEl("detaljGrunner");
const detaljBeskrivelseEl = krevEl("detaljBeskrivelse");
const detaljListeEl = krevEl<HTMLDListElement>("detaljListe");
const detaljHandlingEl = krevEl("detaljHandling");

let person: Portalperson;
let portal: Portalvisning;
let preferanser: Portalpreferanser;
let registreringer: Portalregistrering[] = [];
let samtykke: Samtykke = null;

/**
 * Begrunnelseskoden, som en setning innbyggeren leser.
 *
 * `farge` er `ds-tag`-varianten. To av kodene står med vilje ikke her:
 * `utenfor_interessene` og `maalgruppe_ukjent` sier at vi ikke vet noe, og et
 * merke som sier «vi vet ikke» på hvert eneste kort er støy framfor
 * opplysning. Resten vises, også de negative - særlig de negative.
 *
 * Teksten er deterministisk i dag. Skal en modell skrive den, er det denne
 * listen den skal skrive ut av: kodene er skåringens svar, og modellen
 * formulerer dem. Den rangerer ikke, og den avgjør ikke.
 */
const BEGRUNNELSE: Record<string, { tekst: string; farge?: string } | null> = {
  treffer_interesse: { tekst: "Passer med interessene dine", farge: "success" },
  utenfor_interessene: null,
  i_maalgruppen: { tekst: "For din aldersgruppe", farge: "success" },
  gjelder_alle: { tekst: "Åpent for alle" },
  utenfor_maalgruppen: { tekst: "Rettet mot en annen aldersgruppe", farge: "warning" },
  maalgruppe_ukjent: null,
  rullestoladkomst: { tekst: "Rullestoladkomst", farge: "success" },
  rullestol_ikke_oppgitt: { tekst: "Rullestoladkomst ikke oppgitt", farge: "warning" },
  mangler_rullestoladkomst: { tekst: "Ingen rullestoladkomst", farge: "danger" },
  teleslynge: { tekst: "Teleslynge", farge: "success" },
  teleslynge_mangler: { tekst: "Ingen teleslynge", farge: "warning" },
  teleslynge_ikke_oppgitt: { tekst: "Teleslynge ikke oppgitt", farge: "warning" },
  utenfor_kommunen: { tekst: "Ligger i en annen kommune", farge: "danger" }
};

/** Ikonet står for fargen, ikke for koden - samme fargekategori skal se lik ut. */
const IKON_FOR_FARGE: Record<string, string> = {
  success: "✓",
  warning: "⚠",
  danger: "✕"
};
const IKON_NOYTRAL = "•";

/**
 * Hva som faktisk skjedde med bekreftelsen, sagt til innbyggeren der og da.
 *
 * Backend svarer med kanalen nettopp for at hun ikke skal oppdage det ved at
 * ingenting kommer. `INGEN` er et utfall og ikke en feil - en reservert
 * innbygger har tatt et valg, og det skal stå som et valg og ikke som en
 * beklagelse. Se VARSELKANALER i apps/shared/varsel.ts.
 */
function bekreftelsestekst(bekreftelse: Bekreftelse | undefined): string {
  if (!bekreftelse) return "Du får ingen egen melding om denne påmeldingen.";
  if (bekreftelse.kanal === "SMS") return "Vi har sendt deg en bekreftelse på SMS.";
  if (bekreftelse.kanal === "EPOST") return "Vi har sendt deg en bekreftelse på e-post.";
  if (bekreftelse.grunn === "reservert") {
    return "Du er reservert mot digital kommunikasjon, så vi sender ingen melding. "
      + "Påmeldingen er registrert.";
  }
  return "Vi fant ingen måte å sende deg en bekreftelse på. "
    + "Ta kontakt med kommunen hvis du vil bli minnet på tilbudet.";
}

/** Kommunens kategoriverdier som ord. Vises som en overskrift over navnet, ikke som et valg. */
const KATEGORINAVN: Record<string, string> = {
  "bolig-og-hverdagsmestring": "Bolig og hverdagsmestring",
  dagaktivitet: "Dagaktivitet",
  "digital-mestring": "Digital mestring",
  "friluftsliv-og-trening": "Friluftsliv og trening",
  "frivillighet-og-sosial-stotte": "Frivillighet og sosial støtte",
  "helse-og-trening": "Helse og trening",
  "kultur-og-fellesskap": "Kultur og fellesskap",
  "mat-og-ernaering": "Mat og ernæring",
  "psykisk-helse-og-mestring": "Psykisk helse og mestring"
};

/** Ett lite ikon per kategori, vist ved siden av kategorinavnet - rent dekorativt. */
const KATEGORIIKON: Record<string, string> = {
  "bolig-og-hverdagsmestring": "🏠",
  dagaktivitet: "📅",
  "digital-mestring": "💻",
  "friluftsliv-og-trening": "🥾",
  "frivillighet-og-sosial-stotte": "🤝",
  "helse-og-trening": "💪",
  "kultur-og-fellesskap": "🎭",
  "mat-og-ernaering": "🍽️",
  "psykisk-helse-og-mestring": "🧠"
};

function element<K extends keyof HTMLElementTagNameMap>(
  tagg: K,
  klassenavn?: string,
  tekst?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagg);
  if (klassenavn) node.className = klassenavn;
  if (tekst !== undefined) node.textContent = tekst;
  return node;
}

async function api<T>(sti: string, valg: RequestInit = {}): Promise<T> {
  const svar = await fetch(`${backendBase}${sti}`, {
    ...valg,
    headers: withToken({ ...(valg.body ? { "Content-Type": "application/json" } : {}) })
  });
  const data = await svar.json();
  if (!svar.ok) throw new Error(data.feil || `Tjenesten svarte ${svar.status}.`);
  return data as T;
}

function visStatus(tekst: string, farge?: "success" | "warning" | "danger"): void {
  statusEl.replaceChildren(element("p", "ds-paragraph", tekst));
  if (farge) statusEl.dataset.color = farge;
  else delete statusEl.dataset.color;
  statusEl.hidden = false;
}

function lesbarKode(verdi: string): string {
  const tekst = verdi.replaceAll("oe", "ø").replaceAll("aa", "å").replaceAll("-", " ");
  return tekst.charAt(0).toUpperCase() + tekst.slice(1);
}

function formatDato(dato: string): string {
  const [aar, maaned, dag] = dato.split("-").map(Number);
  return new Intl.DateTimeFormat("nb-NO", { dateStyle: "long" }).format(
    new Date(Date.UTC(aar, maaned - 1, dag))
  );
}

function formatTidspunkt(tilbud: Portaltilbud): string | null {
  const tidspunkt = tilbud.tidspunkter[0];
  if (!tidspunkt) return null;
  const dager = (tidspunkt.ukedager ?? []).map(lesbarKode).join(", ");
  const klokkeslett = tidspunkt.tilKlokkeslett
    ? `${tidspunkt.fraKlokkeslett}-${tidspunkt.tilKlokkeslett}`
    : `fra ${tidspunkt.fraKlokkeslett}`;
  return [dager, klokkeslett].filter(Boolean).join(" ");
}

function formatPris(tilbud: Portaltilbud): string | null {
  if (!tilbud.pris) return null;
  if (tilbud.pris.type === "gratis") return "Gratis";
  if (tilbud.pris.beloepKr !== undefined) return `${tilbud.pris.beloepKr} kr`;
  if (tilbud.pris.beskrivelse) return tilbud.pris.beskrivelse;
  return lesbarKode(tilbud.pris.type);
}

/** Telefonen eller nettsiden, så et utelukket tilbud fortsatt kan følges opp. */
function formatKontakt(tilbud: Portaltilbud): string | null {
  const kontakt = tilbud.kontakt ?? {};
  const verdier = ["telefon", "epost", "nettside"]
    .map((noekkel) => kontakt[noekkel])
    .filter((verdi): verdi is string => typeof verdi === "string");
  return verdier.length > 0 ? verdier.join(" - ") : null;
}

function leggTilDetalj(liste: HTMLDListElement, navn: string, verdi: string | null): void {
  if (!verdi) return;
  liste.append(element("dt", undefined, navn), element("dd", undefined, verdi));
}

function leggTilOpplysning(liste: HTMLDListElement, navn: string, verdi: string): void {
  const gruppe = element("div");
  gruppe.append(element("dt", undefined, navn), element("dd", undefined, verdi));
  liste.append(gruppe);
}

function kategorinavnFor(kategori: string): string {
  return KATEGORINAVN[kategori] ?? lesbarKode(kategori);
}

function alleTilbud(): Portaltilbud[] {
  const rader = [...portal.anbefalte, ...portal.andre, ...portal.utelukkede];
  if (portal.valgtTilbud && !rader.some((rad) => rad.tilbudId === portal.valgtTilbud!.tilbudId)) {
    rader.push(portal.valgtTilbud);
  }
  return rader;
}

function finnTilbud(tilbudId: string): Portaltilbud | null {
  return alleTilbud().find((rad) => rad.tilbudId === tilbudId) ?? null;
}

function finnRegistrering(registreringId: string): Portalregistrering | null {
  return registreringer.find((rad) => rad.registreringId === registreringId) ?? null;
}

function tilbudssti(): string {
  const tilbudId = new URLSearchParams(location.search).get("tilbudId");
  return tilbudId
    ? `${PORTAL_ENDPOINTS.tilbud}?tilbudId=${encodeURIComponent(tilbudId)}`
    : PORTAL_ENDPOINTS.tilbud;
}

/** Lenken fra et kort til aktivitetens egen detaljside. */
function tilbudUrl(tilbudId: string): string {
  return `?tilbudId=${encodeURIComponent(tilbudId)}`;
}

/** Lenken fra et kort i «Mine påmeldinger» til påmeldingens egen detaljside. */
function registreringUrl(registreringId: string): string {
  return `?registreringId=${encodeURIComponent(registreringId)}&fane=paameldinger`;
}

/** Grunnene til at kortet står der det står, som ikon+tekst-rader. Kortets hovedelement. */
function renderGrunner(rad: Portaltilbud): HTMLUListElement | null {
  const liste = element("ul", "portal-grunner");
  liste.setAttribute("aria-label", "Hvorfor dette tilbudet");
  for (const kode of rad.begrunnelseskoder) {
    const grunn = BEGRUNNELSE[kode];
    if (!grunn) continue;
    const punkt = element("li", "portal-grunn");
    if (grunn.farge) punkt.dataset.color = grunn.farge;
    punkt.append(
      element("span", "portal-grunn__ikon", grunn.farge ? IKON_FOR_FARGE[grunn.farge] : IKON_NOYTRAL),
      element("span", "portal-grunn__tekst", grunn.tekst)
    );
    liste.append(punkt);
  }
  return liste.childElementCount > 0 ? liste : null;
}

/**
 * Kortet er selve lenken til detaljsiden (`<a class="ds-card">`), ikke bare en
 * ramme rundt en knapp. Derfor ligger «Meld på» og alt annet klikkbart der, ikke
 * her - to klikkbare ting inni hverandre er ugyldig HTML.
 */
function renderTilbud(
  mottaker: HTMLElement,
  rader: Portaltilbud[],
  valg: { utelukket?: boolean } = {}
): void {
  mottaker.replaceChildren();
  for (const rad of rader) {
    const kort = element("a", `ds-card portal-card${valg.utelukket ? " portal-card--utelukket" : ""}`);
    kort.href = tilbudUrl(rad.tilbudId);

    const topp = element("div", "ds-card__block portal-card__topp");
    const kategorirad = element("div", "portal-card__kategorirad");
    //const ikon = KATEGORIIKON[rad.kategori];
    //if (ikon) {
    //  const ikonEl = element("span", "portal-card__kategoriikon", ikon);
    //  ikonEl.setAttribute("aria-hidden", "true");
    //  kategorirad.append(ikonEl);
    //}
    kategorirad.append(element("p", "portal-card__kategori", kategorinavnFor(rad.kategori)));
    topp.append(
      kategorirad,
      element("h3", "ds-heading", rad.tilbudsnavn ?? rad.navn)
    );
    const grunner = renderGrunner(rad);
    if (grunner) topp.append(grunner);
    const tidSted = [formatTidspunkt(rad), rad.steder[0]?.navn].filter(Boolean).join(" · ");
    if (tidSted) topp.append(element("p", "portal-card__teaser", tidSted));
    kort.append(topp);

    if (valg.utelukket) {
      const handlingdel = element("div", "ds-card__block portal-offer");
      handlingdel.append(element("p", "portal-meta",
        "Vi kan ikke melde deg på herfra - trykk for å se hvordan du kan ta kontakt."));
      kort.append(handlingdel);
    } else if (!rad.paameldingKreves) {
      const handlingdel = element("div", "ds-card__block portal-offer");
      handlingdel.append(element("p", "portal-meta", "Du kan møte opp - ingen påmelding nødvendig"));
      kort.append(handlingdel);
    }
    mottaker.append(kort);
  }
}

function renderAnbefalinger(): void {
  renderTilbud(tilbudEl, portal.anbefalte);
  renderTilbud(andretilbudEl, portal.andre);
  renderTilbud(utelukketEl, portal.utelukkede, { utelukket: true });
  visAktivitetslister();
  if (portal.anbefalte.length === 0 && portal.preferanserValgt) {
    visStatus(
      "Vi fant ingen tilbud som traff interessene dine. Alt kommunen har står under «Andre aktiviteter».",
      "warning"
    );
  } else {
    statusEl.hidden = true;
  }
}

function visAktivitetslister(): void {
  tilbudsseksjonEl.hidden = portal.anbefalte.length === 0;
  andretilbudsseksjonEl.hidden = portal.andre.length === 0;
  utelukketseksjonEl.hidden = portal.utelukkede.length === 0;
}

function renderRegistreringer(): void {
  paameldingerEl.replaceChildren();
  ingenPaameldingerEl.hidden = registreringer.length > 0;
  for (const registrering of registreringer) {
    const kort = element("a", "ds-card portal-card");
    kort.href = registreringUrl(registrering.registreringId);
    const innhold = element("div", "ds-card__block");
    innhold.append(
      element("h3", "ds-heading", registrering.navn),
      element("p", "portal-meta", `Påmeldt ${formatDato(registrering.opprettet.slice(0, 10))}`),
      element("p", "ds-paragraph", "Påmeldingen er mottatt.")
    );
    kort.append(innhold);
    paameldingerEl.append(kort);
  }
  paameldingerFane.textContent = registreringer.length > 0
    ? `Mine påmeldinger (${registreringer.length})`
    : "Mine påmeldinger";
}

async function hentPaaNytt(): Promise<void> {
  [portal, registreringer] = await Promise.all([
    api<Portalvisning>(tilbudssti()),
    api<Registreringsrespons>(PORTAL_ENDPOINTS.registreringer).then((respons) => respons.registreringer)
  ]);
}

function visFane(fane: "aktiviteter" | "paameldinger"): void {
  const viserAktiviteter = fane === "aktiviteter";
  aktiviteterFane.setAttribute("aria-selected", String(viserAktiviteter));
  aktiviteterFane.tabIndex = viserAktiviteter ? 0 : -1;
  paameldingerFane.setAttribute("aria-selected", String(!viserAktiviteter));
  paameldingerFane.tabIndex = viserAktiviteter ? -1 : 0;
  aktiviteterPanelEl.hidden = !viserAktiviteter;
  paameldingerPanelEl.hidden = viserAktiviteter;
}

/** Detaljsiden for én aktivitet eller én påmelding. Skjuler alt annet i `<main>`. */
function visDetalj(): void {
  introEl.hidden = true;
  portalfanerEl.hidden = true;
  samtykkeseksjonEl.hidden = true;
  preferanseseksjonEl.hidden = true;
  aktiviteterPanelEl.hidden = true;
  paameldingerPanelEl.hidden = true;
  aktivitetsdetaljseksjonEl.hidden = false;
  aktivitetsdetaljseksjonEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderPreferanser(): void {
  preferansevalgEl.replaceChildren();
  for (const gruppe of preferanser.tilgjengeligeGrupper) {
    const felt = element("div", "ds-field portal-preference");
    const avkrysning = element("input", "ds-input") as HTMLInputElement;
    avkrysning.type = "checkbox";
    avkrysning.name = "gruppe";
    avkrysning.value = gruppe.verdi;
    avkrysning.id = `preferanse-${gruppe.verdi}`;
    avkrysning.checked = preferanser.grupper.includes(gruppe.verdi);
    const etikett = element("label", "ds-label", gruppe.label);
    etikett.htmlFor = avkrysning.id;
    etikett.dataset.weight = "regular";
    felt.append(avkrysning, etikett);
    preferansevalgEl.append(felt);
  }
  renderTilrettelegging();
}

/**
 * De to tilretteleggingsspørsmålene, med tre svar hver.
 *
 * «Vet ikke» er ikke det samme som «nei», og den forskjellen bæres helt inn i
 * skåringen: et ubesvart spørsmål filtrerer ingenting, mens et nei gjør det. Se
 * `Tilgjengelighet` i apps/shared/senioraktivitet.ts.
 */
function renderTilrettelegging(): void {
  tilretteleggingsvalgEl.replaceChildren();
  const spoersmaal = [
    { navn: "rullestol", tekst: "Trenger du rullestoladkomst?", valgt: preferanser.rullestol },
    { navn: "teleslynge", tekst: "Har du nytte av teleslynge?", valgt: preferanser.teleslynge }
  ];
  for (const rad of spoersmaal) {
    const gruppe = element("fieldset", "ds-fieldset");
    const forklaring = element("legend", "ds-label", rad.tekst);
    forklaring.dataset.weight = "regular";
    gruppe.append(forklaring);
    const rekke = element("div", "portal-radiorekke");
    const alternativer: { verdi: string; label: string }[] = [
      { verdi: "ja", label: "Ja" },
      { verdi: "nei", label: "Nei" },
      { verdi: "", label: "Vet ikke" }
    ];
    for (const alternativ of alternativer) {
      const felt = element("div", "portal-radio");
      const knapp = element("input", "ds-input") as HTMLInputElement;
      knapp.type = "radio";
      knapp.name = rad.navn;
      knapp.value = alternativ.verdi;
      knapp.id = `${rad.navn}-${alternativ.verdi || "ukjent"}`;
      knapp.checked = alternativ.verdi === (rad.valgt === undefined ? "" : rad.valgt ? "ja" : "nei");
      const etikett = element("label", "ds-label", alternativ.label);
      etikett.htmlFor = knapp.id;
      etikett.dataset.weight = "regular";
      felt.append(knapp, etikett);
      rekke.append(felt);
    }
    gruppe.append(rekke);
    tilretteleggingsvalgEl.append(gruppe);
  }
}

/** `true`, `false` eller utelatt - den tredje tilstanden bæres videre som ingenting. */
function lesRadio(navn: string): boolean | undefined {
  const valgt = tilretteleggingsvalgEl
    .querySelector<HTMLInputElement>(`input[name="${navn}"]:checked`);
  if (!valgt || valgt.value === "") return undefined;
  return valgt.value === "ja";
}

/**
 * Ja/nei, ikke tre svar som tilretteleggingen over.
 *
 * VENTER_PAA_SVAR - ubesvart - er fraværet av et valg, ikke et tredje
 * alternativ å velge: samtykke.ts sin tilstandsmaskin går bare ut av den til
 * SAMTYKKET eller IKKE_SAMTYKKET, så det finnes ikke noe tredje svar å gi.
 */
function renderSamtykke(): void {
  samtykkevalgEl.replaceChildren();
  const status = samtykke?.status;
  const alternativer: { verdi: string; label: string }[] = [
    { verdi: "ja", label: "Ja" },
    { verdi: "nei", label: "Nei" }
  ];
  for (const alternativ of alternativer) {
    const felt = element("div", "portal-radio");
    const knapp = element("input", "ds-input") as HTMLInputElement;
    knapp.type = "radio";
    knapp.name = "samtykke";
    knapp.value = alternativ.verdi;
    knapp.id = `samtykke-${alternativ.verdi}`;
    knapp.checked = (alternativ.verdi === "ja" && status === "SAMTYKKET")
      || (alternativ.verdi === "nei" && status === "IKKE_SAMTYKKET");
    const etikett = element("label", "ds-label", alternativ.label);
    etikett.htmlFor = knapp.id;
    etikett.dataset.weight = "regular";
    felt.append(knapp, etikett);
    samtykkevalgEl.append(felt);
  }

  const STATUSTEKST: Record<string, string> = {
    SAMTYKKET: "Du har sagt ja til å bli kontaktet.",
    IKKE_SAMTYKKET: "Du har sagt nei til å bli kontaktet.",
    TRUKKET: "Du har trukket tilbake samtykket. Du kan si ja igjen når som helst.",
    UTLOEPT: "Samtykket har gått ut. Du kan svare på nytt."
  };
  const tekst = status ? STATUSTEKST[status] : undefined;
  samtykkestatusLinjeEl.hidden = !tekst;
  if (tekst) samtykkestatusLinjeEl.textContent = tekst;
  trekkSamtykkeKnapp.hidden = status !== "SAMTYKKET";
}

/**
 * Lagrer svaret. Uavhengig av lagrePreferanser() og interessene under: de to
 * seksjonene deler ingen tilstand og ingen lagreknapp.
 *
 * Et samtykke som alt er avgjort - ja, nei eller trukket - kan ikke svares på
 * en gang til (SAMTYKKEOVERGANGER tillater det ikke), så et nytt svar der
 * ber om en ny samtykkeforespørsel framfor å gjenbruke den gamle. Bare et
 * ubesvart samtykke (VENTER_PAA_SVAR, eller ingen ennå) svarer på den samme
 * forespørselen.
 */
async function lagreSamtykke(): Promise<void> {
  const valgt = samtykkevalgEl.querySelector<HTMLInputElement>('input[name="samtykke"]:checked');
  if (!valgt) {
    samtykkefeilEl.textContent = "Velg ja eller nei.";
    samtykkefeilEl.hidden = false;
    return;
  }
  samtykkefeilEl.hidden = true;
  const status = valgt.value === "ja" ? "SAMTYKKET" : "IKKE_SAMTYKKET";
  lagreSamtykkeKnapp.disabled = true;
  try {
    const trengerNyForespoersel = !samtykke || samtykke.status !== "VENTER_PAA_SVAR";
    const samtykkeId = trengerNyForespoersel
      ? (await api<{ samtykkeId: string }>(PORTAL_ENDPOINTS.samtykke, { method: "POST" })).samtykkeId
      : samtykke!.samtykkeId;
    samtykke = await api<Samtykke>(`${PORTAL_ENDPOINTS.samtykke}/${samtykkeId}/svar`, {
      method: "PUT",
      body: JSON.stringify({ status })
    });
    renderSamtykke();
  } catch (feil) {
    samtykkefeilEl.textContent = feilmelding(feil);
    samtykkefeilEl.hidden = false;
  } finally {
    lagreSamtykkeKnapp.disabled = false;
  }
}

async function trekkTilbakeSamtykke(): Promise<void> {
  if (!samtykke?.samtykkeId) return;
  trekkSamtykkeKnapp.disabled = true;
  try {
    samtykke = await api<Samtykke>(`${PORTAL_ENDPOINTS.samtykke}/${samtykke.samtykkeId}/trekk`, { method: "PUT" });
    renderSamtykke();
  } catch (feil) {
    samtykkefeilEl.textContent = feilmelding(feil);
    samtykkefeilEl.hidden = false;
  } finally {
    trekkSamtykkeKnapp.disabled = false;
  }
}

function visPreferanser(redigering: boolean): void {
  renderPreferanser();
  preferansefeilEl.hidden = true;
  tilbudsseksjonEl.hidden = true;
  andretilbudsseksjonEl.hidden = true;
  utelukketseksjonEl.hidden = true;
  aktivitetsdetaljseksjonEl.hidden = true;
  avbrytPreferanserKnapp.hidden = !redigering;
  preferanseseksjonEl.hidden = false;
}

async function lagrePreferanser(): Promise<void> {
  const grupper = [...preferansevalgEl.querySelectorAll<HTMLInputElement>('input[name="gruppe"]:checked')]
    .map((felt) => felt.value);
  if (grupper.length === 0) {
    preferansefeilEl.textContent = "Velg minst én interesse.";
    preferansefeilEl.hidden = false;
    return;
  }
  const rullestol = lesRadio("rullestol");
  const teleslynge = lesRadio("teleslynge");
  lagrePreferanserKnapp.disabled = true;
  try {
    preferanser = await api<Portalpreferanser>(PORTAL_ENDPOINTS.preferanser, {
      method: "PUT",
      body: JSON.stringify({
        grupper,
        ...(rullestol === undefined ? {} : { rullestol }),
        ...(teleslynge === undefined ? {} : { teleslynge })
      })
    });
    portal = await api<Portalvisning>(tilbudssti());
    preferanseseksjonEl.hidden = true;
    renderAnbefalinger();
    const tilbudId = new URLSearchParams(location.search).get("tilbudId");
    if (tilbudId) await visAktivitetsdetalj(tilbudId);
  } catch (feil) {
    preferansefeilEl.textContent = feil instanceof Error ? feil.message : "Kunne ikke lagre valgene.";
    preferansefeilEl.hidden = false;
  } finally {
    lagrePreferanserKnapp.disabled = false;
  }
}

/**
 * Navn, e-post, telefon og hva som kontrolleres - det som før sto på en egen
 * «Kontroller og bekreft»-side, står nå nederst på detaljsiden. Ett trykk på
 * knappen melder på med det samme; det er ikke et eget steg til.
 */
async function visPaameldingsblokk(rad: Portaltilbud): Promise<void> {
  const kontaktinfo = await api<Kontaktinfo>(PORTAL_ENDPOINTS.kontaktinfo);
  const innhold = element("div");
  innhold.append(element("p", "ds-paragraph",
    "Dette bruker vi når du melder deg på:"));
  const dataliste = element("dl", "portal-summary");
  leggTilOpplysning(dataliste, "Navn", person.visningsnavn);
  leggTilOpplysning(dataliste, "E-post", kontaktinfo.epost?.adresse ?? "Ikke registrert");
  leggTilOpplysning(dataliste, "Telefon", kontaktinfo.tlf?.nummer ?? "Ikke registrert");
  leggTilOpplysning(dataliste, "Kontrolleres",
    `${formatDato(person.foedselsdato)} og ${person.bostedsadresse?.kommune ?? "kommune ikke registrert"}`);
  innhold.append(dataliste);
  innhold.append(element("p", "ds-paragraph", "Fødselsdato og kommune brukes bare til å kontrollere at tilbudet er tilgjengelig for deg."));
  const knapp = element("button", "ds-button", "Meld deg på") as HTMLButtonElement;
  knapp.type = "button";
  knapp.addEventListener("click", () => void bekreftPaamelding(rad.tilbudId, knapp));
  innhold.append(knapp);
  detaljHandlingEl.append(innhold);
}

async function bekreftPaamelding(tilbudId: string, knapp: HTMLButtonElement): Promise<void> {
  knapp.disabled = true;
  detaljHandlingEl.querySelectorAll(".ds-alert").forEach((el) => el.remove());
  try {
    const svar = await api<Registreringsrespons>(PORTAL_ENDPOINTS.registreringer, {
      method: "POST",
      body: JSON.stringify({ tilbudIder: [tilbudId] })
    });
    await hentPaaNytt();
    renderAnbefalinger();
    renderRegistreringer();
    const bekreftelse = svar.bekreftelser?.find((rad) => rad.tilbudId === tilbudId);
    detaljHandlingEl.replaceChildren();
    const varsel = element("div", "ds-alert");
    varsel.dataset.color = "success";
    varsel.append(
      element("h2", "ds-heading", "Påmeldingen er registrert"),
      element("p", "ds-paragraph", bekreftelsestekst(bekreftelse)),
      element("p", "portal-meta", `Kvittering: ${svar.sporingsId}`)
    );
    detaljHandlingEl.append(varsel);
    const knapperad = element("div", "portal-actions");
    const tilOversikt = element("a", "ds-button", "Tilbake til oversikten");
    tilOversikt.href = location.pathname;
    const tilPaameldinger = element("a", "ds-button", "Se mine påmeldinger");
    tilPaameldinger.dataset.variant = "secondary";
    tilPaameldinger.href = `${location.pathname}?fane=paameldinger`;
    knapperad.append(tilOversikt, tilPaameldinger);
    detaljHandlingEl.append(knapperad);
  } catch (feil) {
    knapp.disabled = false;
    const varsel = element("div", "ds-alert");
    varsel.dataset.color = "danger";
    varsel.append(
      element("p", "ds-paragraph", feil instanceof Error ? feil.message : "Kunne ikke registrere påmeldingen.")
    );
    detaljHandlingEl.append(varsel);
  }
}

async function fjernPaamelding(
  registrering: Portalregistrering,
  knapp: HTMLButtonElement
): Promise<void> {
  knapp.disabled = true;
  detaljHandlingEl.querySelectorAll(".ds-alert").forEach((el) => el.remove());
  try {
    await api(`${PORTAL_ENDPOINTS.registreringer}/${encodeURIComponent(registrering.registreringId)}`, {
      method: "DELETE"
    });
    await hentPaaNytt();
    renderAnbefalinger();
    renderRegistreringer();
    detaljHandlingEl.replaceChildren();
    const varsel = element("div", "ds-alert");
    varsel.dataset.color = "success";
    varsel.append(element("p", "ds-paragraph", `Påmeldingen til ${registrering.navn} er fjernet.`));
    detaljHandlingEl.append(varsel);
    const tilbake = element("a", "ds-button", "Tilbake til mine påmeldinger");
    tilbake.href = `${location.pathname}?fane=paameldinger`;
    detaljHandlingEl.append(tilbake);
  } catch (feil) {
    knapp.disabled = false;
    const varsel = element("div", "ds-alert");
    varsel.dataset.color = "danger";
    varsel.append(
      element("p", "ds-paragraph", feil instanceof Error ? feil.message : "Kunne ikke fjerne påmeldingen.")
    );
    detaljHandlingEl.append(varsel);
  }
}

/**
 * Detaljsiden for ett tilbud - anbefalt, annet eller utelukket. Det som før var
 * kortets «Vis detaljer»-nedtrekk og den separate «Kontroller og bekreft»-siden
 * er samlet her.
 */
async function visAktivitetsdetalj(tilbudId: string): Promise<void> {
  const rad = finnTilbud(tilbudId);
  if (!rad) throw new Error("Aktiviteten er ikke tilgjengelig for deg.");
  const utelukket = portal.utelukkede.some((u) => u.tilbudId === tilbudId);

  tilbakeLenkeEl.href = location.pathname;
  detaljKategoriEl.textContent = kategorinavnFor(rad.kategori);
  detaljKategoriEl.hidden = false;
  detaljTittelEl.textContent = rad.tilbudsnavn ?? rad.navn;

  detaljGrunnerEl.replaceChildren();
  const grunner = renderGrunner(rad);
  if (grunner) detaljGrunnerEl.append(grunner);

  detaljBeskrivelseEl.textContent = rad.beskrivelse;
  detaljBeskrivelseEl.hidden = !rad.beskrivelse;

  detaljListeEl.replaceChildren();
  leggTilDetalj(detaljListeEl, "Tilbyder", rad.tilbyder);
  leggTilDetalj(detaljListeEl, "Form", rad.former.map(lesbarKode).join(", "));
  leggTilDetalj(detaljListeEl, "Tid", formatTidspunkt(rad));
  leggTilDetalj(detaljListeEl, "Sted", rad.steder.map((sted) => sted.navn).join(", ") || null);
  leggTilDetalj(detaljListeEl, "Pris", formatPris(rad));
  leggTilDetalj(detaljListeEl, "Kontakt", formatKontakt(rad));
  detaljListeEl.hidden = detaljListeEl.childElementCount === 0;

  detaljHandlingEl.replaceChildren();
  if (utelukket) {
    // Ingen påmeldingsknapp: skåringen stengte tilbudet, og backend avviser
    // det samme kallet. En knapp som alltid feiler er verre enn ingen knapp.
    detaljHandlingEl.append(element("p", "portal-meta",
      "Vi kan ikke melde deg på herfra, men arrangøren svarer gjerne på hva som er mulig - se kontaktinformasjonen over."));
  } else if (rad.paameldingKreves) {
    await visPaameldingsblokk(rad);
  } else {
    detaljHandlingEl.append(element("p", "portal-meta", "Du kan møte opp - ingen påmelding nødvendig"));
  }

  visDetalj();
}

/** Detaljsiden for én påmelding under «Mine påmeldinger». */
function visRegistreringDetalj(registreringId: string): void {
  const registrering = finnRegistrering(registreringId);
  if (!registrering) throw new Error("Påmeldingen finnes ikke lenger.");

  tilbakeLenkeEl.href = `${location.pathname}?fane=paameldinger`;
  detaljKategoriEl.hidden = true;
  detaljTittelEl.textContent = registrering.navn;
  detaljGrunnerEl.replaceChildren();
  detaljBeskrivelseEl.hidden = true;
  detaljListeEl.replaceChildren();
  detaljListeEl.hidden = true;

  detaljHandlingEl.replaceChildren();
  detaljHandlingEl.append(
    element("p", "portal-meta", `Påmeldt ${formatDato(registrering.opprettet.slice(0, 10))}`),
    element("p", "ds-paragraph", "Påmeldingen er mottatt.")
  );
  const fjernKnapp = element("button", "ds-button", "Fjern påmelding") as HTMLButtonElement;
  fjernKnapp.type = "button";
  fjernKnapp.dataset.variant = "secondary";
  fjernKnapp.dataset.color = "danger";
  fjernKnapp.addEventListener("click", () => void fjernPaamelding(registrering, fjernKnapp));
  detaljHandlingEl.append(fjernKnapp);

  visDetalj();
}

async function start(): Promise<void> {
  if (!(await requireLogin())) return;
  [person, portal, preferanser, registreringer, samtykke] = await Promise.all([
    api<Portalperson>(PORTAL_ENDPOINTS.meg),
    api<Portalvisning>(tilbudssti()),
    api<Portalpreferanser>(PORTAL_ENDPOINTS.preferanser),
    api<Registreringsrespons>(PORTAL_ENDPOINTS.registreringer).then((respons) => respons.registreringer),
    api<{ samtykke: Samtykke }>(PORTAL_ENDPOINTS.samtykke).then((respons) => respons.samtykke)
  ]);
  krevEl("merkenavn").textContent = `${person.bostedsadresse?.kommune ?? "Min"} aktivitetsportal`;
  krevEl("tittel").textContent = `Hei, ${person.visningsnavn}`;
  krevEl("ingress").textContent = portal.portalTilgjengelig
    ? "Her er aktiviteter som kan passe for deg."
    : portal.alder < portal.aldersgrense
      ? `Aktivitetsanbefalingene blir tilgjengelige når du fyller ${portal.aldersgrense} år.`
      : `Aktivitetskatalogen gjelder innbyggere i ${portal.kommunenavn}.`;
  krevEl("kontaktkommune").textContent = `Kontakt ${person.bostedsadresse?.kommune ?? "kommunen"} hvis du trenger hjelp.`;
  const vaapen = krevEl<HTMLImageElement>("kommunevaapen");
  if (person.bostedsadresse?.kommunenummer) {
    vaapen.src = `https://static.fiks.ks.no/img/kommunevaapen/${person.bostedsadresse.kommunenummer}.png`;
    vaapen.alt = `${person.bostedsadresse.kommune ?? "Kommunens"} våpen`;
    vaapen.hidden = false;
  }
  statusEl.hidden = true;
  introEl.hidden = false;
  portalfanerEl.hidden = false;
  renderSamtykke();
  samtykkeseksjonEl.hidden = false;

  const parametre = new URLSearchParams(location.search);
  visFane(parametre.get("fane") === "paameldinger" ? "paameldinger" : "aktiviteter");
  renderRegistreringer();
  if (portal.portalTilgjengelig) {
    if (preferanser.ferdigstilt) renderAnbefalinger();
    else visPreferanser(false);
  }

  const registreringId = parametre.get("registreringId");
  const tilbudId = parametre.get("tilbudId");
  if (registreringId) {
    visRegistreringDetalj(registreringId);
  } else if (tilbudId && portal.portalTilgjengelig && preferanser.ferdigstilt) {
    await visAktivitetsdetalj(tilbudId);
  }
}

krevEl<HTMLButtonElement>("byttBruker").addEventListener("click", switchUser);
aktiviteterFane.addEventListener("click", () => visFane("aktiviteter"));
paameldingerFane.addEventListener("click", () => visFane("paameldinger"));
for (const fane of [aktiviteterFane, paameldingerFane]) {
  fane.addEventListener("keydown", (hendelse) => {
    if (hendelse.key !== "ArrowLeft" && hendelse.key !== "ArrowRight") return;
    hendelse.preventDefault();
    const neste = fane === aktiviteterFane ? paameldingerFane : aktiviteterFane;
    neste.click();
    neste.focus();
  });
}
lagreSamtykkeKnapp.addEventListener("click", () => void lagreSamtykke());
trekkSamtykkeKnapp.addEventListener("click", () => void trekkTilbakeSamtykke());
lagrePreferanserKnapp.addEventListener("click", () => void lagrePreferanser());
avbrytPreferanserKnapp.addEventListener("click", () => {
  preferanseseksjonEl.hidden = true;
  visAktivitetslister();
});
krevEl<HTMLButtonElement>("endrePreferanser").addEventListener("click", () => visPreferanser(true));

start().catch((feil) => visStatus(feil instanceof Error ? feil.message : "Noe gikk galt.", "danger"));
