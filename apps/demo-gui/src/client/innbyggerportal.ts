export {};

const backendBase = "http://localhost:8080";

const PORTAL_ENDPOINTS = {
  meg: "/api/innbyggerportal/placeholder/meg",
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
  tilbydere: { tilbyderId: string; navn: string }[];
};

type Kontaktinfo = {
  epost?: { adresse?: string } | null;
  tlf?: { nummer?: string } | null;
};

const statusEl = krevEl("status");
const introEl = krevEl("intro");
const tilbudsseksjonEl = krevEl("tilbudsseksjon");
const tilbudEl = krevEl("tilbud");
const paameldingsseksjonEl = krevEl("paameldingsseksjon");
const paameldingsdataEl = krevEl("paameldingsdata");
const paameldingsforklaringEl = krevEl("paameldingsforklaring");
const bekreftKnapp = krevEl<HTMLButtonElement>("bekreftPaamelding");
const kvitteringEl = krevEl("kvittering");

let person: Portalperson;
let portal: Portalrespons;
let valgtTilbudId: string | null = null;

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

function erAnbefalt(aktivitet: Aktivitet): boolean {
  return aktivitet.maalgrupper.some((maalgruppe) => {
    if (!maalgruppe.alder) return true;
    return portal.alder >= (maalgruppe.alder.fraAar ?? 0)
      && portal.alder <= (maalgruppe.alder.tilAar ?? Number.POSITIVE_INFINITY);
  });
}

function finnTilbud(tilbudId: string): { aktivitet: Aktivitet; tilbud: Tilbud } | null {
  for (const aktivitet of portal.aktiviteter) {
    const tilbud = aktivitet.tilbud.find((kandidat) => kandidat.tilbudId === tilbudId);
    if (tilbud) return { aktivitet, tilbud };
  }
  return null;
}

function renderAnbefalinger(): void {
  tilbudEl.replaceChildren();
  const anbefalte = portal.aktiviteter.filter(erAnbefalt);
  for (const aktivitet of anbefalte) {
    const kort = element("article", "ds-card portal-card");
    const innhold = element("div", "ds-card__block");
    innhold.append(
      element("h3", "ds-heading", aktivitet.navn),
      element("p", "ds-paragraph", aktivitet.beskrivelse),
      element("p", "portal-meta", `Anbefalt ut fra alder ${portal.alder} år og bosted i ${portal.kommunenavn}`)
    );
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
    tilbudEl.append(kort);
  }
  tilbudsseksjonEl.hidden = anbefalte.length === 0;
  if (anbefalte.length === 0) {
    visStatus("Vi fant ingen anbefalte aktiviteter for opplysningene dine.", "warning");
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
    tilbudsseksjonEl.hidden = false;
    kvitteringEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    bekreftKnapp.disabled = false;
  }
}

function avbrytPaamelding(): void {
  valgtTilbudId = null;
  paameldingsseksjonEl.hidden = true;
  tilbudsseksjonEl.hidden = false;
}

async function start(): Promise<void> {
  if (!(await requireLogin())) return;
  [person, portal] = await Promise.all([
    api<Portalperson>(PORTAL_ENDPOINTS.meg),
    api<Portalrespons>(PORTAL_ENDPOINTS.tilbud)
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
  if (portal.portalTilgjengelig) renderAnbefalinger();

  const tilbudId = new URLSearchParams(location.search).get("tilbudId");
  if (tilbudId && portal.portalTilgjengelig) await visOppsummering(tilbudId);
}

krevEl<HTMLButtonElement>("byttBruker").addEventListener("click", switchUser);
bekreftKnapp.addEventListener("click", () => void bekreftPaamelding());
krevEl<HTMLButtonElement>("avbrytPaamelding").addEventListener("click", avbrytPaamelding);

start().catch((feil) => visStatus(feil instanceof Error ? feil.message : "Noe gikk galt.", "danger"));