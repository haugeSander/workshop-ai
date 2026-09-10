export {};

const backendBase = "http://localhost:8080";
const katalogsti = "/api/innbyggerportal/placeholder/aktiviteter";

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
  tilbud: Tilbud[];
};

type Katalog = {
  kommunenavn: string;
  kommunenummer: string;
  aktiviteter: Aktivitet[];
  tilbydere: { tilbyderId: string; navn: string }[];
};

const statusEl = document.getElementById("status")!;
const introEl = document.getElementById("intro")!;
const filterseksjonEl = document.getElementById("filterseksjon")!;
const tilbudsseksjonEl = document.getElementById("tilbudsseksjon")!;
const kategorifiltreEl = document.getElementById("kategorifiltre")!;
const tilbudEl = document.getElementById("tilbud")!;
const resultatantallEl = document.getElementById("resultatantall")!;
const valgteKategorier = new Set<string>();
let katalog: Katalog;

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

function lesbarKode(verdi: string): string {
  const tekst = verdi.replaceAll("oe", "ø").replaceAll("aa", "å").replaceAll("-", " ");
  return tekst.charAt(0).toUpperCase() + tekst.slice(1);
}

function kategorinavnFor(kategori: string): string {
  return kategorinavn[kategori] ?? lesbarKode(kategori);
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

function formatTilgjengelighet(tilbud: Tilbud): string {
  if (!tilbud.tilgjengelighet) return "Ikke oppgitt";
  const deler: string[] = [];
  if (tilbud.tilgjengelighet.rullestol === true) deler.push("rullestoladkomst");
  if (tilbud.tilgjengelighet.rullestol === false) deler.push("ikke rullestoladkomst");
  if (tilbud.tilgjengelighet.teleslynge === true) deler.push("teleslynge");
  if (tilbud.tilgjengelighet.teleslynge === false) deler.push("ikke teleslynge");
  return deler.length ? deler.join(", ") : "Ikke oppgitt";
}

function leggTilDetalj(liste: HTMLUListElement, navn: string, verdi: string | null): void {
  if (verdi) liste.append(element("li", undefined, `${navn}: ${verdi}`));
}

function renderAktiviteter(): void {
  const aktiviteter = valgteKategorier.size === 0
    ? katalog.aktiviteter
    : katalog.aktiviteter.filter((aktivitet) => valgteKategorier.has(aktivitet.kategori));
  resultatantallEl.textContent = `${aktiviteter.length} ${aktiviteter.length === 1 ? "aktivitet" : "aktiviteter"}`;
  tilbudEl.replaceChildren();

  for (const aktivitet of aktiviteter) {
    const kort = element("article", "ds-card portal-card");
    const innhold = element("div", "ds-card__block portal-card__intro");
    innhold.append(
      element("p", "portal-category", kategorinavnFor(aktivitet.kategori)),
      element("h3", "ds-heading", aktivitet.navn),
      element("p", "ds-paragraph", aktivitet.beskrivelse)
    );
    kort.append(innhold);

    for (const tilbud of aktivitet.tilbud) {
      const tilbyder = katalog.tilbydere.find((kandidat) => kandidat.tilbyderId === tilbud.tilbyderId);
      const tilbudsdel = element("div", "ds-card__block portal-offer");
      tilbudsdel.append(element("h4", "ds-heading", tilbud.navn ?? tilbyder?.navn ?? aktivitet.navn));
      const detaljer = element("ul", "portal-details");
      leggTilDetalj(detaljer, "Tilbyder", tilbyder?.navn ?? null);
      leggTilDetalj(detaljer, "Form", tilbud.gjennomforing.former.map(lesbarKode).join(", "));
      leggTilDetalj(detaljer, "Tid", formatTidspunkt(tilbud));
      leggTilDetalj(detaljer, "Sted", tilbud.steder?.map((sted) => sted.navn).join(", ") ?? null);
      leggTilDetalj(detaljer, "Pris", formatPris(tilbud));
      leggTilDetalj(detaljer, "Tilgjengelighet", formatTilgjengelighet(tilbud));
      tilbudsdel.append(detaljer);
      if (tilbud.paamelding?.kreves) {
        const lenke = element("a", "ds-button", "Meld på");
        lenke.href = `/innbyggerportal?tilbudId=${encodeURIComponent(tilbud.tilbudId)}`;
        tilbudsdel.append(lenke);
      } else {
        tilbudsdel.append(element("p", "portal-meta", "Ingen påmelding nødvendig"));
      }
      kort.append(tilbudsdel);
    }
    tilbudEl.append(kort);
  }
}

function renderFiltre(): void {
  const kategorier = [...new Set(katalog.aktiviteter.map((aktivitet) => aktivitet.kategori))].sort();
  for (const kategori of kategorier) {
    const felt = element("div", "ds-field portal-filter");
    const avkrysning = element("input", "ds-input") as HTMLInputElement;
    avkrysning.type = "checkbox";
    avkrysning.id = `kategori-${kategori}`;
    const etikett = element("label", "ds-label", kategorinavnFor(kategori));
    etikett.htmlFor = avkrysning.id;
    etikett.dataset.weight = "regular";
    avkrysning.addEventListener("change", () => {
      if (avkrysning.checked) valgteKategorier.add(kategori);
      else valgteKategorier.delete(kategori);
      renderAktiviteter();
    });
    felt.append(avkrysning, etikett);
    kategorifiltreEl.append(felt);
  }
}

async function start(): Promise<void> {
  const svar = await fetch(`${backendBase}${katalogsti}`);
  if (!svar.ok) throw new Error(`Tjenesten svarte ${svar.status}.`);
  katalog = await svar.json() as Katalog;
  document.getElementById("merkenavn")!.textContent = `${katalog.kommunenavn} aktivitetsportal`;
  document.getElementById("tittel")!.textContent = `Aktiviteter i ${katalog.kommunenavn}`;
  document.getElementById("kontaktkommune")!.textContent = `Kontakt ${katalog.kommunenavn} kommune hvis du trenger hjelp.`;
  const vaapen = document.getElementById("kommunevaapen") as HTMLImageElement;
  vaapen.src = `https://static.fiks.ks.no/img/kommunevaapen/${katalog.kommunenummer}.png`;
  vaapen.alt = `${katalog.kommunenavn} kommunes våpen`;
  vaapen.hidden = false;
  renderFiltre();
  renderAktiviteter();
  statusEl.hidden = true;
  introEl.hidden = false;
  filterseksjonEl.hidden = false;
  tilbudsseksjonEl.hidden = false;
}

document.getElementById("nullstillFiltre")!.addEventListener("click", () => {
  valgteKategorier.clear();
  kategorifiltreEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((felt) => { felt.checked = false; });
  renderAktiviteter();
});

start().catch((feil) => {
  statusEl.replaceChildren(element("p", "ds-paragraph", feil instanceof Error ? feil.message : "Noe gikk galt."));
  statusEl.dataset.color = "danger";
});
