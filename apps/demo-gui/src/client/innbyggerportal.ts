export {};

const backendBase = "http://localhost:8080";

const PORTAL_ENDPOINTS = {
  meg: "/api/innbyggerportal/placeholder/meg",
  preferanser: "/api/innbyggerportal/placeholder/preferanser",
  tilbud: "/api/innbyggerportal/placeholder/tilbud",
  kontaktinfo: "/api/innbyggerportal/placeholder/kontaktinfo",
  registreringer: "/api/innbyggerportal/placeholder/registreringer"
} as const;

type Portalperson = Person & {
  foedselsdato: string;
  bostedsadresse?: { kommune?: string | null; kommunenummer?: string | null } | null;
};

type Tilbud = {
  tilbudId: string;
  tilbyderId: string;
  navn?: string;
  gjennomforing: { former: string[] };
  tidspunkter?: { ukedager?: string[]; fraKlokkeslett: string; tilKlokkeslett?: string }[];
  steder?: { navn: string }[];
  pris?: { type: string; beloepKr?: number; beskrivelse?: string };
  paamelding?: { kreves: boolean };
  tilgjengelighet?: { rullestol?: boolean; teleslynge?: boolean };
};

type Aktivitet = {
  aktivitetId: string;
  navn: string;
  kategori: string;
  beskrivelse: string;
  maalgrupper: { alder?: { fraAar?: number; tilAar?: number } }[];
  tilbud: Tilbud[];
};

type Portalrespons = {
  alder: number;
  portalTilgjengelig: boolean;
  kommunenavn: string;
  kommunenummer: string;
  aktiviteter: Aktivitet[];
  andreAktiviteter: Aktivitet[];
  tilbydere: { tilbyderId: string; navn: string }[];
  preferanserValgt: boolean;
  valgteKategorier: string[];
  valgtAktivitet: Aktivitet | null;
};

type Portalpreferanser = {
  ferdigstilt: boolean;
  kategorier: string[];
  tilgjengeligeKategorier: string[];
};

type Kontaktinfo = {
  epost?: { adresse?: string } | null;
  tlf?: { nummer?: string } | null;
};

const statusEl = krevEl("status");
const introEl = krevEl("intro");
const preferanseseksjonEl = krevEl("preferanseseksjon");
const preferansevalgEl = krevEl("preferansevalg");
const preferansefeilEl = krevEl("preferansefeil");
const lagrePreferanserKnapp = krevEl<HTMLButtonElement>("lagrePreferanser");
const avbrytPreferanserKnapp = krevEl<HTMLButtonElement>("avbrytPreferanser");
const tilbudsseksjonEl = krevEl("tilbudsseksjon");
const tilbudEl = krevEl("tilbud");
const andretilbudsseksjonEl = krevEl("andretilbudsseksjon");
const andretilbudEl = krevEl("andretilbud");
const paameldingsseksjonEl = krevEl("paameldingsseksjon");
const paameldingsdataEl = krevEl("paameldingsdata");
const paameldingsforklaringEl = krevEl("paameldingsforklaring");
const bekreftKnapp = krevEl<HTMLButtonElement>("bekreftPaamelding");
const kvitteringEl = krevEl("kvittering");

let person: Portalperson;
let portal: Portalrespons;
let preferanser: Portalpreferanser;
let valgtTilbudId: string | null = null;

const kategorinavn: Record<string, string> = {
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

function formatTidspunkt(tilbud: Tilbud): string | null {
  const tidspunkt = tilbud.tidspunkter?.[0];
  if (!tidspunkt) return null;
  const dager = (tidspunkt.ukedager ?? []).map(lesbarKode).join(", ");
  const klokkeslett = tidspunkt.tilKlokkeslett
    ? `${tidspunkt.fraKlokkeslett}-${tidspunkt.tilKlokkeslett}`
    : `fra ${tidspunkt.fraKlokkeslett}`;
  return [dager, klokkeslett].filter(Boolean).join(" ");
}

function formatPris(tilbud: Tilbud): string | null {
  if (!tilbud.pris) return null;
  if (tilbud.pris.type === "gratis") return "Gratis";
  if (tilbud.pris.beloepKr !== undefined) return `${tilbud.pris.beloepKr} kr`;
  return tilbud.pris.beskrivelse ?? lesbarKode(tilbud.pris.type);
}

function leggTilDetalj(liste: HTMLUListElement, navn: string, verdi: string | null): void {
  if (verdi) liste.append(element("li", undefined, `${navn}: ${verdi}`));
}

function kategorinavnFor(kategori: string): string {
  return kategorinavn[kategori] ?? lesbarKode(kategori);
}

function finnTilbud(tilbudId: string): { aktivitet: Aktivitet; tilbud: Tilbud } | null {
  const aktiviteter = portal.valgtAktivitet
    ? [...portal.aktiviteter, ...portal.andreAktiviteter, portal.valgtAktivitet]
    : [...portal.aktiviteter, ...portal.andreAktiviteter];
  for (const aktivitet of aktiviteter) {
    const tilbud = aktivitet.tilbud.find((kandidat) => kandidat.tilbudId === tilbudId);
    if (tilbud) return { aktivitet, tilbud };
  }
  return null;
}

function tilbudssti(): string {
  const tilbudId = new URLSearchParams(location.search).get("tilbudId");
  return tilbudId
    ? `${PORTAL_ENDPOINTS.tilbud}?tilbudId=${encodeURIComponent(tilbudId)}`
    : PORTAL_ENDPOINTS.tilbud;
}

function renderAktiviteter(mottaker: HTMLElement, aktiviteter: Aktivitet[], visBegrunnelse: boolean): void {
  mottaker.replaceChildren();
  for (const aktivitet of aktiviteter) {
    const kort = element("article", "ds-card portal-card");
    const innhold = element("div", "ds-card__block");
    innhold.append(
      element("h3", "ds-heading", aktivitet.navn),
      element("p", "ds-paragraph", aktivitet.beskrivelse)
    );
    if (visBegrunnelse) {
      innhold.append(
        element("p", "portal-meta", `Anbefalt fordi du valgte ${kategorinavnFor(aktivitet.kategori).toLowerCase()}`)
      );
    }
    kort.append(innhold);

    for (const tilbud of aktivitet.tilbud) {
      const tilbyder = portal.tilbydere.find((kandidat) => kandidat.tilbyderId === tilbud.tilbyderId);
      const tilbudsdel = element("div", "ds-card__block portal-offer");
      tilbudsdel.append(element("h4", "ds-heading", tilbud.navn ?? tilbyder?.navn ?? aktivitet.navn));
      const detaljer = element("ul", "portal-details");
      leggTilDetalj(detaljer, "Tilbyder", tilbyder?.navn ?? null);
      leggTilDetalj(detaljer, "Form", tilbud.gjennomforing.former.map(lesbarKode).join(", "));
      leggTilDetalj(detaljer, "Tid", formatTidspunkt(tilbud));
      leggTilDetalj(detaljer, "Sted", tilbud.steder?.map((sted) => sted.navn).join(", ") ?? null);
      leggTilDetalj(detaljer, "Pris", formatPris(tilbud));
      tilbudsdel.append(detaljer);
      if (tilbud.paamelding?.kreves) {
        const knapp = element("button", "ds-button", "Meld på") as HTMLButtonElement;
        knapp.type = "button";
        knapp.addEventListener("click", () => void visOppsummering(tilbud.tilbudId));
        tilbudsdel.append(knapp);
      } else {
        tilbudsdel.append(element("p", "portal-meta", "Ingen påmelding nødvendig"));
      }
      kort.append(tilbudsdel);
    }
    mottaker.append(kort);
  }
}

function renderAnbefalinger(): void {
  const anbefalte = portal.aktiviteter;
  renderAktiviteter(tilbudEl, anbefalte, true);
  renderAktiviteter(andretilbudEl, portal.andreAktiviteter, false);
  visAktivitetslister();
  if (anbefalte.length === 0) {
    visStatus("Vi fant ingen anbefalte aktiviteter for opplysningene dine.", "warning");
  }
}

function visAktivitetslister(): void {
  tilbudsseksjonEl.hidden = portal.aktiviteter.length === 0;
  andretilbudsseksjonEl.hidden = portal.andreAktiviteter.length === 0;
}

function renderPreferanser(): void {
  preferansevalgEl.replaceChildren();
  for (const kategori of preferanser.tilgjengeligeKategorier) {
    const felt = element("div", "ds-field portal-preference");
    const avkrysning = element("input", "ds-input") as HTMLInputElement;
    avkrysning.type = "checkbox";
    avkrysning.name = "kategori";
    avkrysning.value = kategori;
    avkrysning.id = `preferanse-${kategori}`;
    avkrysning.checked = preferanser.kategorier.includes(kategori);
    const etikett = element("label", "ds-label", kategorinavnFor(kategori));
    etikett.htmlFor = avkrysning.id;
    etikett.dataset.weight = "regular";
    felt.append(avkrysning, etikett);
    preferansevalgEl.append(felt);
  }
}

function visPreferanser(redigering: boolean): void {
  renderPreferanser();
  preferansefeilEl.hidden = true;
  tilbudsseksjonEl.hidden = true;
  andretilbudsseksjonEl.hidden = true;
  paameldingsseksjonEl.hidden = true;
  avbrytPreferanserKnapp.hidden = !redigering;
  preferanseseksjonEl.hidden = false;
}

async function lagrePreferanser(): Promise<void> {
  const kategorier = [...preferansevalgEl.querySelectorAll<HTMLInputElement>('input[name="kategori"]:checked')]
    .map((felt) => felt.value);
  if (kategorier.length === 0) {
    preferansefeilEl.textContent = "Velg minst én kategori.";
    preferansefeilEl.hidden = false;
    return;
  }
  lagrePreferanserKnapp.disabled = true;
  try {
    preferanser = await api<Portalpreferanser>(PORTAL_ENDPOINTS.preferanser, {
      method: "PUT",
      body: JSON.stringify({ kategorier })
    });
    portal = await api<Portalrespons>(tilbudssti());
    preferanseseksjonEl.hidden = true;
    renderAnbefalinger();
    const tilbudId = new URLSearchParams(location.search).get("tilbudId");
    if (tilbudId) await visOppsummering(tilbudId);
  } finally {
    lagrePreferanserKnapp.disabled = false;
  }
}

function leggTilOpplysning(navn: string, verdi: string): void {
  const gruppe = element("div");
  gruppe.append(element("dt", undefined, navn), element("dd", undefined, verdi));
  paameldingsdataEl.append(gruppe);
}

async function visOppsummering(tilbudId: string): Promise<void> {
  const treff = finnTilbud(tilbudId);
  if (!treff) throw new Error("Aktiviteten er ikke tilgjengelig for deg.");
  const kontaktinfo = await api<Kontaktinfo>(PORTAL_ENDPOINTS.kontaktinfo);
  const tilbyder = portal.tilbydere.find((kandidat) => kandidat.tilbyderId === treff.tilbud.tilbyderId);
  valgtTilbudId = tilbudId;
  paameldingsdataEl.replaceChildren();
  leggTilOpplysning("Aktivitet", treff.aktivitet.navn);
  leggTilOpplysning("Tilbyder", tilbyder?.navn ?? "Ikke oppgitt");
  leggTilOpplysning("Navn", person.visningsnavn);
  leggTilOpplysning("E-post", kontaktinfo.epost?.adresse ?? "Ikke registrert");
  leggTilOpplysning("Telefon", kontaktinfo.tlf?.nummer ?? "Ikke registrert");
  leggTilOpplysning("Kontrolleres", `${formatDato(person.foedselsdato)} og ${person.bostedsadresse?.kommune ?? "kommune ikke registrert"}`);
  paameldingsforklaringEl.textContent =
    "Navn og kontaktinformasjon brukes til påmeldingen. Fødselsdato og kommune brukes bare til å kontrollere at tilbudet er tilgjengelig for deg.";
  tilbudsseksjonEl.hidden = true;
  andretilbudsseksjonEl.hidden = true;
  paameldingsseksjonEl.hidden = false;
  paameldingsseksjonEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function bekreftPaamelding(): Promise<void> {
  if (!valgtTilbudId) return;
  bekreftKnapp.disabled = true;
  try {
    const svar = await api<{ sporingsId: string }>(PORTAL_ENDPOINTS.registreringer, {
      method: "POST",
      body: JSON.stringify({ tilbudIder: [valgtTilbudId] })
    });
    valgtTilbudId = null;
    paameldingsseksjonEl.hidden = true;
    const varsel = element("div", "ds-alert");
    varsel.dataset.color = "success";
    varsel.append(
      element("h2", "ds-heading", "Påmeldingen er registrert"),
      element("p", "ds-paragraph", `Kvittering: ${svar.sporingsId}`)
    );
    kvitteringEl.replaceChildren(varsel);
    visAktivitetslister();
    kvitteringEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    bekreftKnapp.disabled = false;
  }
}

function avbrytPaamelding(): void {
  valgtTilbudId = null;
  paameldingsseksjonEl.hidden = true;
  visAktivitetslister();
}

async function start(): Promise<void> {
  if (!(await requireLogin())) return;
  [person, portal, preferanser] = await Promise.all([
    api<Portalperson>(PORTAL_ENDPOINTS.meg),
    api<Portalrespons>(tilbudssti()),
    api<Portalpreferanser>(PORTAL_ENDPOINTS.preferanser)
  ]);
  krevEl("merkenavn").textContent = `${person.bostedsadresse?.kommune ?? "Min"} aktivitetsportal`;
  krevEl("tittel").textContent = `Hei, ${person.visningsnavn}`;
  krevEl("ingress").textContent = portal.portalTilgjengelig
    ? "Her er aktiviteter som kan passe for deg."
    : portal.alder < 62
      ? "Aktivitetsanbefalingene blir tilgjengelige når du fyller 62 år."
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
  if (portal.portalTilgjengelig) {
    if (preferanser.ferdigstilt) renderAnbefalinger();
    else visPreferanser(false);
  }

  const tilbudId = new URLSearchParams(location.search).get("tilbudId");
  if (tilbudId && portal.portalTilgjengelig && preferanser.ferdigstilt) await visOppsummering(tilbudId);
}

krevEl<HTMLButtonElement>("byttBruker").addEventListener("click", switchUser);
lagrePreferanserKnapp.addEventListener("click", () => void lagrePreferanser());
avbrytPreferanserKnapp.addEventListener("click", () => {
  preferanseseksjonEl.hidden = true;
  visAktivitetslister();
});
krevEl<HTMLButtonElement>("endrePreferanser").addEventListener("click", () => visPreferanser(true));
bekreftKnapp.addEventListener("click", () => void bekreftPaamelding());
krevEl<HTMLButtonElement>("avbrytPaamelding").addEventListener("click", avbrytPaamelding);

start().catch((feil) => visStatus(feil instanceof Error ? feil.message : "Noe gikk galt.", "danger"));