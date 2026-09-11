export {};

const backendBase = "http://localhost:8080";

type Portalperson = Person & {
  bostedsadresse?: { kommune?: string | null; kommunenummer?: string | null } | null;
};

type Portalrespons = {
  alder: number;
  portalTilgjengelig: boolean;
  anbefalte: unknown[];
  andre: unknown[];
  utelukkede: unknown[];
  preferanserValgt: boolean;
};

type Registreringsrespons = {
  registreringer: unknown[];
};

async function api<T>(sti: string): Promise<T> {
  const svar = await fetch(`${backendBase}${sti}`, { headers: withToken() });
  const data = await svar.json();
  if (!svar.ok) throw new Error(data.feil || `Tjenesten svarte ${svar.status}.`);
  return data as T;
}

async function start(): Promise<void> {
  if (!(await requireLogin())) return;
  const [person, portal, registreringer] = await Promise.all([
    api<Portalperson>("/api/innbyggerportal/placeholder/meg"),
    api<Portalrespons>("/api/innbyggerportal/placeholder/tilbud"),
    api<Registreringsrespons>("/api/innbyggerportal/placeholder/registreringer")
  ]);

  krevEl("merkenavn").textContent = `${person.bostedsadresse?.kommune ?? "Min"} innbyggerportal`;
  krevEl("tittel").textContent = `Hei, ${person.visningsnavn}`;
  krevEl("kontaktkommune").textContent = `Kontakt ${person.bostedsadresse?.kommune ?? "kommunen"} hvis du trenger hjelp.`;

  const vaapen = krevEl<HTMLImageElement>("kommunevaapen");
  if (person.bostedsadresse?.kommunenummer) {
    vaapen.src = `https://static.fiks.ks.no/img/kommunevaapen/${person.bostedsadresse.kommunenummer}.png`;
    vaapen.alt = `${person.bostedsadresse.kommune ?? "Kommunens"} våpen`;
    vaapen.hidden = false;
  }

  const tilgjengelige = portal.anbefalte.length + portal.andre.length;
  krevEl("aktivitetsbeskrivelse").textContent = portal.portalTilgjengelig
    ? portal.preferanserValgt
      ? "Se anbefalte aktiviteter, resten av tilbudene og påmeldingene dine."
      : "Velg interesser for å få anbefalinger som passer for deg."
    : portal.alder < 62
      ? "Aktivitetstjenesten blir tilgjengelig når du fyller 62 år."
      : "Aktivitetstjenesten er ikke tilgjengelig i kommunen din.";
  krevEl("aktivitetsstatus").textContent = portal.portalTilgjengelig
    ? `${tilgjengelige} aktiviteter tilgjengelig · ${registreringer.registreringer.length} påmeldinger`
    : "Ikke tilgjengelig ennå";

  krevEl("status").hidden = true;
  krevEl("intro").hidden = false;
  krevEl("tjenester").hidden = false;
}

krevEl<HTMLButtonElement>("byttBruker").addEventListener("click", switchUser);

start().catch((feil) => {
  const status = krevEl("status");
  status.textContent = feil instanceof Error ? feil.message : "Noe gikk galt.";
  status.dataset.color = "danger";
});