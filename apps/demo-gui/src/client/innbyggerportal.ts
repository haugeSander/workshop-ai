export {};

const backendBase = "http://localhost:8080";

// Replace only these paths when the real portal backend is ready.
export const PORTAL_ENDPOINTS = {
  meg: "/api/innbyggerportal/placeholder/meg",
  tilbud: "/api/innbyggerportal/placeholder/tilbud",
  kontaktinfo: "/api/innbyggerportal/placeholder/kontaktinfo",
  samtykke: "/api/innbyggerportal/placeholder/samtykke",
  samtykkesvar: (samtykkeId: string) =>
    `/api/innbyggerportal/placeholder/samtykke/${encodeURIComponent(samtykkeId)}/svar`,
  registreringer: "/api/innbyggerportal/placeholder/registreringer"
} as const;

type Portalperson = Person & {
  foedselsdato: string;
  navn: { fornavn: string; mellomnavn?: string | null; etternavn: string };
  bostedsadresse?: {
    adressenavn?: string | null;
    husnummer?: string | number | null;
    postnummer?: string | null;
    poststed?: string | null;
    kommune?: string | null;
    kommunenummer?: string | null;
  } | null;
  skjermet?: boolean;
};

type Tilbud = {
  tilbudId: string;
  tilbyderId: string;
  navn?: string;
  gjennomforing: { former: string[]; tilrettelegging?: string[] };
  tidspunkter?: {
    ukedager: string[];
    fraKlokkeslett: string;
    tilKlokkeslett?: string;
  }[];
  steder?: { navn: string }[];
  pris?: { type: string; beloepKr?: number; beskrivelse?: string };
  paamelding?: { kreves: boolean; informasjon?: string };
  tilgjengelighet?: { rullestol?: boolean; teleslynge?: boolean };
};

type Seniortilbud = {
  aktivitetId: string;
  navn: string;
  kategori: string;
  beskrivelse: string;
  status: string;
  maalgrupper: {
    alder?: { fraAar?: number; tilAar?: number };
  }[];
  tilbud: Tilbud[];
};

type Tilbyder = {
  tilbyderId: string;
  navn: string;
  type: string;
};

type Tilbudssvar = {
  alder: number;
  portalTilgjengelig: boolean;
  kommunenavn: string;
  kommunenummer: string;
  schemaVersjon: number;
  aktiviteter: Seniortilbud[];
  tilbydere: Tilbyder[];
};

type Registrering = {
  registreringId: string;
  aktivitetId: string;
  tilbudId: string;
  navn: string;
  status: string;
};

type Kontaktinfo = {
  epost?: { adresse?: string } | null;
  tlf?: { nummer?: string } | null;
  advarsel?: string;
};

const statusEl = krevEl("status");
const introEl = krevEl("intro");
const opplysningerEl = krevEl("opplysninger");
const tilbudsseksjonEl = krevEl("tilbudsseksjon");
const persondataEl = krevEl("persondata");
const tilbudEl = krevEl("tilbud");
const kvitteringEl = krevEl("kvittering");
const kontaktstatusEl = krevEl("kontaktstatus");
const samtykkehandlingerEl = krevEl("samtykkehandlinger");
const sendValgKnapp = krevEl<HTMLButtonElement>("sendValg");

let person: Portalperson;
let tilbudssvar: Tilbudssvar;
let registrerte = new Set<string>();

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
    headers: withToken({
      ...(valg.body ? { "Content-Type": "application/json" } : {}),
      ...(valg.headers as Record<string, string> | undefined)
    })
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

function leggTilOpplysning(navn: string, verdi: string): void {
  const gruppe = element("div");
  gruppe.append(element("dt", undefined, navn), element("dd", undefined, verdi));
  persondataEl.append(gruppe);
}

function formatDato(dato: string): string {
  const [aar, maaned, dag] = dato.split("-").map(Number);
  return new Intl.DateTimeFormat("nb-NO", { dateStyle: "long" }).format(
    new Date(Date.UTC(aar, maaned - 1, dag))
  );
}

function formatAdresse(): string {
  if (person.skjermet || !person.bostedsadresse?.adressenavn) return "Skjermet eller ikke registrert";
  const gate = [person.bostedsadresse.adressenavn, person.bostedsadresse.husnummer]
    .filter(Boolean).join(" ");
  const sted = [person.bostedsadresse.postnummer, person.bostedsadresse.poststed]
    .filter(Boolean).join(" ");
  return [gate, sted].filter(Boolean).join(", ");
}

function renderPerson(): void {
  const kommune = person.bostedsadresse?.kommune || "kommunen din";
  krevEl("merkenavn").textContent = `${kommune} innbyggerportal`;
  krevEl("tittel").textContent = `Velkommen til ${kommune} innbyggerportal`;
  krevEl("ingress").textContent = tilbudssvar.portalTilgjengelig
    ? `Her finner du tilbud som kan være aktuelle for deg som er ${tilbudssvar.alder} år.`
    : tilbudssvar.alder < 62
      ? "Tilbudene blir tilgjengelige her når du fyller 62 år."
      : `Denne aktivitetskatalogen gjelder innbyggere i ${tilbudssvar.kommunenavn}.`;
  krevEl("kontaktkommune").textContent = `Kontakt ${kommune} hvis du trenger hjelp.`;

  const vaapen = krevEl<HTMLImageElement>("kommunevaapen");
  if (person.bostedsadresse?.kommunenummer) {
    vaapen.src = `https://static.fiks.ks.no/img/kommunevaapen/${person.bostedsadresse.kommunenummer}.png`;
    vaapen.alt = `${kommune} kommunes våpen`;
    vaapen.hidden = false;
  }

  persondataEl.replaceChildren();
  leggTilOpplysning("Navn", person.visningsnavn);
  leggTilOpplysning("Fødselsdato", formatDato(person.foedselsdato));
  leggTilOpplysning("Alder", `${tilbudssvar.alder} år`);
  leggTilOpplysning("Kommune", kommune);
  leggTilOpplysning("Adresse", formatAdresse());
}

function lesbarKode(verdi: string): string {
  return verdi.replaceAll("oe", "ø").replaceAll("aa", "å").replaceAll("-", " ");
}

function formatTidspunkt(tilbud: Tilbud): string | null {
  const tidspunkt = tilbud.tidspunkter?.[0];
  if (!tidspunkt) return null;
  const dager = tidspunkt.ukedager.map(lesbarKode).join(", ");
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

function formatTilgjengelighet(tilbud: Tilbud): string {
  if (!tilbud.tilgjengelighet) return "Tilgjengelighet er ikke oppgitt";
  const deler: string[] = [];
  if (tilbud.tilgjengelighet.rullestol === true) deler.push("rullestoladkomst");
  if (tilbud.tilgjengelighet.rullestol === false) deler.push("ikke rullestoladkomst");
  if (tilbud.tilgjengelighet.teleslynge === true) deler.push("teleslynge");
  if (tilbud.tilgjengelighet.teleslynge === false) deler.push("ikke teleslynge");
  return deler.length ? deler.join(", ") : "Tilgjengelighet er ikke oppgitt";
}

function leggTilDetalj(liste: HTMLUListElement, navn: string, verdi: string | null): void {
  if (verdi) liste.append(element("li", undefined, `${navn}: ${verdi}`));
}

function renderTilbud(): void {
  tilbudEl.replaceChildren();
  for (const aktivitet of tilbudssvar.aktiviteter) {
    const kort = element("article", "ds-card portal-card");
    const innhold = element("div", "ds-card__block");
    innhold.append(
      element("h3", "ds-heading", aktivitet.navn),
      element("p", "ds-paragraph", aktivitet.beskrivelse)
    );
    const aldersgrenser = aktivitet.maalgrupper
      .flatMap((maalgruppe) => maalgruppe.alder?.fraAar ?? [])
      .sort((venstre, hoeyre) => venstre - hoeyre);
    if (aldersgrenser.length) {
      innhold.append(element("p", "portal-meta", `Målgruppe fra ${aldersgrenser[0]} år`));
    }
    kort.append(innhold);

    for (const tilbud of aktivitet.tilbud) {
      const handling = element("div", "ds-card__block portal-offer");
      const tilbyder = tilbudssvar.tilbydere.find(
        (kandidat) => kandidat.tilbyderId === tilbud.tilbyderId
      );
      handling.append(element("h4", "ds-heading", tilbud.navn ?? tilbyder?.navn ?? aktivitet.navn));
      const detaljer = element("ul", "portal-details");
      leggTilDetalj(detaljer, "Tilbyder", tilbyder?.navn ?? null);
      leggTilDetalj(detaljer, "Form", tilbud.gjennomforing.former.map(lesbarKode).join(", "));
      leggTilDetalj(detaljer, "Tid", formatTidspunkt(tilbud));
      leggTilDetalj(detaljer, "Sted", tilbud.steder?.map((sted) => sted.navn).join(", ") ?? null);
      leggTilDetalj(detaljer, "Pris", formatPris(tilbud));
      leggTilDetalj(detaljer, "Tilgjengelighet", formatTilgjengelighet(tilbud));
      handling.append(detaljer);

      const felt = element("div", "ds-field");
      const avkrysning = element("input", "ds-input") as HTMLInputElement;
      avkrysning.type = "checkbox";
      avkrysning.name = "tilbud";
      avkrysning.value = tilbud.tilbudId;
      avkrysning.id = `tilbud-${tilbud.tilbudId}`;
      avkrysning.disabled = registrerte.has(tilbud.tilbudId);
      const etikett = element(
        "label",
        "ds-label",
        registrerte.has(tilbud.tilbudId)
          ? "Registrert"
          : tilbud.paamelding?.kreves ? "Meld interesse" : "Be om informasjon"
      );
      etikett.htmlFor = avkrysning.id;
      etikett.dataset.weight = "regular";
      felt.append(avkrysning, etikett);
      handling.append(felt);
      kort.append(handling);
    }
    tilbudEl.append(kort);
  }
  sendValgKnapp.hidden = tilbudssvar.aktiviteter.every((aktivitet) => aktivitet.tilbud.length === 0);
}

function visKontakt(kontakt: Kontaktinfo): void {
  samtykkehandlingerEl.replaceChildren();
  if (kontakt.advarsel) {
    kontaktstatusEl.replaceChildren(element("p", "ds-paragraph", kontakt.advarsel));
    return;
  }
  const deler = [kontakt.epost?.adresse, kontakt.tlf?.nummer].filter(Boolean);
  kontaktstatusEl.replaceChildren(
    element("p", "ds-paragraph", deler.length ? `Kontakt: ${deler.join(" · ")}` : "Ingen kontaktopplysninger er registrert.")
  );
}

function visKontaktvalg(): void {
  kontaktstatusEl.replaceChildren(
    element("p", "ds-paragraph", "Kontaktopplysninger vises bare dersom du samtykker til det.")
  );
  const knapp = element("button", "ds-button", "Se kontaktopplysninger") as HTMLButtonElement;
  knapp.type = "button";
  knapp.dataset.variant = "secondary";
  knapp.addEventListener("click", () => void startSamtykke());
  samtykkehandlingerEl.replaceChildren(knapp);
}

async function hentKontaktinfo(): Promise<void> {
  const svar = await fetch(`${backendBase}${PORTAL_ENDPOINTS.kontaktinfo}`, {
    headers: withToken()
  });
  if (svar.ok) {
    visKontakt(await svar.json() as Kontaktinfo);
    return;
  }
  throw new Error((await svar.json()).feil || "Kunne ikke hente kontaktopplysninger.");
}

async function startSamtykke(): Promise<void> {
  const forespoersel = await api<{ samtykkeId: string }>(PORTAL_ENDPOINTS.samtykke, {
    method: "POST",
    body: "{}"
  });
  kontaktstatusEl.replaceChildren(
    element("p", "ds-paragraph", "Jeg samtykker til at kontaktopplysningene mine brukes til å følge opp tilbud jeg ber om kontakt om.")
  );
  const ja = element("button", "ds-button", "Samtykk") as HTMLButtonElement;
  ja.type = "button";
  const nei = element("button", "ds-button", "Ikke nå") as HTMLButtonElement;
  nei.type = "button";
  nei.dataset.variant = "secondary";
  ja.addEventListener("click", () => void svarSamtykke(forespoersel.samtykkeId, "SAMTYKKET"));
  nei.addEventListener("click", () => void svarSamtykke(forespoersel.samtykkeId, "IKKE_SAMTYKKET"));
  samtykkehandlingerEl.replaceChildren(ja, nei);
}

async function svarSamtykke(samtykkeId: string, status: "SAMTYKKET" | "IKKE_SAMTYKKET"): Promise<void> {
  await api(PORTAL_ENDPOINTS.samtykkesvar(samtykkeId), {
    method: "PUT",
    body: JSON.stringify({ status })
  });
  if (status === "SAMTYKKET") {
    await hentKontaktinfo();
  } else {
    samtykkehandlingerEl.replaceChildren();
    kontaktstatusEl.replaceChildren(element("p", "ds-paragraph", "Kontaktopplysninger er ikke hentet."));
  }
}

async function sendValg(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const valgte = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="tilbud"]:checked'))
    .map((felt) => felt.value);
  if (valgte.length === 0) {
    kvitteringEl.replaceChildren(element("div", "ds-alert", "Velg minst ett tilbud."));
    return;
  }
  sendValgKnapp.disabled = true;
  try {
    const svar = await api<{ registreringer: Registrering[]; sporingsId: string }>(
      PORTAL_ENDPOINTS.registreringer,
      { method: "POST", body: JSON.stringify({ tilbudIder: valgte }) }
    );
    svar.registreringer.forEach((registrering) => registrerte.add(registrering.tilbudId));
    renderTilbud();
    const varsel = element("div", "ds-alert");
    varsel.dataset.color = "success";
    varsel.append(
      element("h3", "ds-heading", "Valgene er registrert"),
      element("p", "ds-paragraph", `Kvittering: ${svar.sporingsId}`)
    );
    kvitteringEl.replaceChildren(varsel);
  } finally {
    sendValgKnapp.disabled = false;
  }
}

async function start(): Promise<void> {
  if (!(await requireLogin())) return;
  const [meg, portal, registreringssvar] = await Promise.all([
    api<Portalperson>(PORTAL_ENDPOINTS.meg),
    api<Tilbudssvar>(PORTAL_ENDPOINTS.tilbud),
    api<{ registreringer: Registrering[] }>(PORTAL_ENDPOINTS.registreringer)
  ]);
  person = meg;
  tilbudssvar = portal;
  registrerte = new Set(
    registreringssvar.registreringer.map((registrering) => registrering.tilbudId)
  );
  renderPerson();
  renderTilbud();
  visKontaktvalg();
  statusEl.hidden = true;
  introEl.hidden = false;
  opplysningerEl.hidden = false;
  tilbudsseksjonEl.hidden = !tilbudssvar.portalTilgjengelig;
}

krevEl<HTMLButtonElement>("byttBruker").addEventListener("click", () => {
  switchUser();
});
krevEl<HTMLFormElement>("tilbudsskjema").addEventListener("submit", (event) => {
  void sendValg(event);
});

start().catch((feil) => visStatus(feil instanceof Error ? feil.message : "Noe gikk galt.", "danger"));