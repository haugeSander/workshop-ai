/*
 * Innbyggerportalens sammenstilling, som rene funksjoner.
 *
 * Uten stack og uten modell: `byggPortalvisning` tar preferansen og
 * påmeldingene som parametere, så det eneste som leses fra disk er katalogen,
 * gruppene og tjenestetilbudene - de tre filene som er inndata uansett.
 *
 * Det testen er her for, er koblingen: portalen skal vise det `rangerTilbud`
 * kom fram til, og ikke sin egen enklere filtrering ved siden av. Den hadde en,
 * og den kjente verken tilgjengelighet, begrunnelse eller utelukkede.
 */
import assert from "node:assert/strict";
import { norskKalenderdato } from "../apps/shared/alder.ts";
import { parseAktivitetskatalog } from "../apps/shared/senioraktivitet.ts";
import { readJson } from "../apps/shared/jsonstore.ts";
import {
  byggPortalvisning,
  hentAktivitetskatalog,
  hentInteressegrupper
} from "../apps/sandbox-backend/src/innbyggerportal.ts";
import type { Portalpreferanse, Portalregistrering } from "../apps/sandbox-backend/src/innbyggerportal.ts";

let sjekker = 0;
function sjekk(betingelse: unknown, melding: string): void {
  assert.ok(betingelse, melding);
  sjekker += 1;
}
function likt(faktisk: unknown, forventet: unknown, melding: string): void {
  assert.deepEqual(faktisk, forventet, melding);
  sjekker += 1;
}

assert.equal(
  norskKalenderdato(Date.parse("2025-12-31T23:30:00Z")),
  "2026-01-01",
  "Portalen skal bruke norsk kalenderdato"
);
sjekker += 1;

// --- katalogen ------------------------------------------------------------

const katalog = await hentAktivitetskatalog();
likt(katalog.kommunenavn, "Ringerike", "katalogen er Ringerikes");
likt(katalog.kommunenummer, "3305", "katalogen har kommunenummeret");
sjekk(katalog.aktiviteter.length > 0, "katalogen har aktiviteter");
sjekk(katalog.tilbydere.length > 0, "katalogen har tilbydere");
likt(katalog.mock, true, "katalogen er merket som mock");
likt(katalog.syntetisk, true, "katalogen er merket som syntetisk");

/*
 * Feltene parseren droppet i stillhet.
 *
 * `navn`, `pris`, `steder` og `kontakt` står i kommunens fil og ble borte i
 * `parseAktivitetskatalog`, som konstruerer et nytt objekt. Portalen viste dem
 * likevel, fordi den leste filen selv med sin egen kopi av typene - og da den
 * sluttet med det, var det ingenting som fanget tapet. Det er den samme feilen
 * `dato` en gang var, og kommentaren over `Tidspunkt` forteller hva den kostet.
 */
const raaKatalog = parseAktivitetskatalog(await readJson("senioraktiviteter.json"));
const medPris = raaKatalog.aktiviteter
  .flatMap((aktivitet) => aktivitet.tilbud)
  .filter((tilbud) => tilbud.pris !== undefined);
sjekk(medPris.length > 0, "parseren bærer `pris` videre");
sjekk(
  raaKatalog.aktiviteter.flatMap((a) => a.tilbud).some((t) => t.steder.length > 0),
  "parseren bærer `steder` videre"
);
sjekk(
  raaKatalog.aktiviteter.flatMap((a) => a.tilbud).some((t) => t.navn !== undefined),
  "parseren bærer tilbudets eget `navn` videre"
);
sjekk(
  raaKatalog.aktiviteter.flatMap((a) => a.tilbud).some((t) => Object.keys(t.kontakt).length > 0),
  "parseren bærer `kontakt` videre"
);

// --- interessegruppene, ikke kommunens kategorier -------------------------

const grupper = await hentInteressegrupper();
sjekk(grupper.some((gruppe) => gruppe.verdi === "friluft"), "gruppen friluft finnes");
sjekk(grupper.every((gruppe) => gruppe.label.trim().length > 0), "hver gruppe har en label");
/*
 * Kategoriene skal ikke ut av porten. En innbygger blir spurt om hva hun er
 * interessert i, ikke om hvilken tjenestekategori kommunen har sortert tilbudet
 * under - se docs/seniorsirkel.md. Portalen spurte om kategoriene før dette.
 */
const kategoriverdier = new Set(raaKatalog.aktiviteter.map((aktivitet) => aktivitet.kategori));
sjekk(
  grupper.every((gruppe) => !kategoriverdier.has(gruppe.verdi)),
  "ingen gruppeverdi er en av kommunens kategorier"
);
sjekk(
  grupper.every((gruppe) => !("kategorier" in gruppe)),
  "gruppene lekker ikke kommunens taksonomi ut i portalen"
);

// --- visningen ------------------------------------------------------------

const RINGERIKE = "3305";
const IDAG = "2026-09-10";
/** Fyller 62 nøyaktig på referansedatoen. Aldersgrensen leses av tjenestetilbudene. */
const FYLLER_62 = "1964-09-10";
const DAGEN_FOER = "1964-09-11";

function preferanse(valg: Partial<Portalpreferanse>): Portalpreferanse {
  return {
    personId: "person-401",
    grupper: [],
    oppdatert: `${IDAG}T09:00:00.000Z`,
    ...valg
  };
}

async function visning(valg: {
  foedselsdato?: string;
  kommunenummer?: string;
  preferanse?: Portalpreferanse | null;
  registreringer?: Portalregistrering[];
  valgtTilbudId?: string | null;
}) {
  return byggPortalvisning({
    personId: "person-401",
    foedselsdato: valg.foedselsdato ?? FYLLER_62,
    kommunenummer: valg.kommunenummer ?? RINGERIKE,
    referansedato: IDAG,
    preferanse: valg.preferanse ?? null,
    registreringer: valg.registreringer ?? [],
    ...(valg.valgtTilbudId === undefined ? {} : { valgtTilbudId: valg.valgtTilbudId })
  });
}

const foerTerskel = await visning({ foedselsdato: DAGEN_FOER });
likt(foerTerskel.portalTilgjengelig, false, "dagen før 62 er portalen ikke tilgjengelig");
likt(foerTerskel.anbefalte, [], "ingen anbefalte under aldersgrensen");
likt(foerTerskel.andre, [], "ingen andre under aldersgrensen");
likt(foerTerskel.utelukkede, [], "ingen utelukkede under aldersgrensen");
likt(foerTerskel.profil, null, "ingen profil bygges under aldersgrensen");
likt(foerTerskel.aldersgrense, 62, "aldersgrensen leses av data/tjenestetilbud.json");

const annenKommune = await visning({ kommunenummer: "0301" });
likt(annenKommune.portalTilgjengelig, false, "katalogen gjelder én kommune");
likt(annenKommune.anbefalte, [], "ingen anbefalte i en annen kommune");

const utenValg = await visning({});
likt(utenValg.portalTilgjengelig, true, "62 år i Ringerike gir tilgang");
likt(utenValg.preferanserValgt, false, "uten preferanse er den ikke valgt");
sjekk(utenValg.antallVurdert > 0, "hele katalogen er vurdert");
likt(utenValg.anbefalte, [], "uten valgte interesser anbefales ingenting");
sjekk(utenValg.andre.length > 0, "uten valgte interesser står alt under «andre»");

// --- skåringen er den som avgjør, ikke portalen ---------------------------

const friluft = await visning({ preferanse: preferanse({ grupper: ["friluft"] }) });
likt(friluft.preferanserValgt, true, "preferansen er valgt");
sjekk(friluft.anbefalte.length > 0, "friluft gir minst ett forslag");
sjekk(
  friluft.anbefalte.every((rad) => rad.begrunnelseskoder.includes("treffer_interesse")),
  "alt under «anbefalte» traff en interesse hun valgte"
);
sjekk(
  friluft.andre.every((rad) => !rad.begrunnelseskoder.includes("treffer_interesse")),
  "ingenting under «andre» traff en interesse"
);
sjekk(
  friluft.anbefalte.every((rad) => (rad.score ?? -1) > 0),
  "et forslag har en skår, aldri null"
);
// Rekkefølgen er skåringens, ikke filens.
const skaarer = friluft.andre.map((rad) => rad.score ?? -1);
likt(
  skaarer,
  [...skaarer].sort((a, b) => b - a),
  "listen er sortert på skår"
);
sjekk(
  friluft.anbefalte.some((rad) => rad.aktivitetId === "lavterskel-turgruppe"),
  "turgruppen ligger under friluft"
);
sjekk(
  friluft.profil?.kategorier.includes("friluftsliv-og-trening"),
  "gruppen er løst opp i kommunens kategorier"
);

// --- tilgjengelighet: det portalen ikke leste i det hele tatt -------------

const TURGRUPPE = "dnt-ringerike-seniorgruppa";
const SPISEVENN = "spisevenn-frivillighet-helse";

const rullestol = await visning({
  preferanse: preferanse({ grupper: ["friluft", "frivillig"], rullestol: true })
});
const utelukketIder = rullestol.utelukkede.map((rad) => rad.tilbudId);
sjekk(
  utelukketIder.includes(TURGRUPPE),
  "turgruppen uten rullestoladkomst er utelukket når behovet er oppgitt"
);
sjekk(
  rullestol.utelukkede
    .find((rad) => rad.tilbudId === TURGRUPPE)
    ?.begrunnelseskoder.includes("mangler_rullestoladkomst"),
  "utelukkelsen bærer koden som sier hvorfor"
);
sjekk(
  ![...rullestol.anbefalte, ...rullestol.andre].some((rad) => rad.tilbudId === TURGRUPPE),
  "et utelukket tilbud står ikke også blant forslagene"
);
likt(
  rullestol.utelukkede.every((rad) => rad.score === null),
  true,
  "et hardt krav gir score null, ikke null poeng"
);
/*
 * «Ikke oppgitt» er ikke «nei». Spisevenn har ingen `tilgjengelighet` i
 * katalogen, og et filter som leste det som nei ville skjult tilbudet for den
 * som trenger det mest. Se `Tilgjengelighet` i apps/shared/senioraktivitet.ts.
 */
sjekk(
  !utelukketIder.includes(SPISEVENN),
  "et tilbud uten oppgitt adkomst utelukkes ikke"
);
sjekk(
  [...rullestol.anbefalte, ...rullestol.andre]
    .find((rad) => rad.tilbudId === SPISEVENN)
    ?.begrunnelseskoder.includes("rullestol_ikke_oppgitt"),
  "ukjent adkomst bæres videre som ukjent"
);

const utenBehov = await visning({ preferanse: preferanse({ grupper: ["friluft"] }) });
sjekk(
  !utenBehov.utelukkede.some((rad) => rad.tilbudId === TURGRUPPE),
  "uten oppgitt behov filtrerer adkomsten ingenting"
);

// --- de utelukkede er ikke navnløse ---------------------------------------

const utelukketTurgruppe = rullestol.utelukkede.find((rad) => rad.tilbudId === TURGRUPPE)!;
sjekk(utelukketTurgruppe.navn.length > 0, "en utelukket rad har navnet sitt");
sjekk(utelukketTurgruppe.beskrivelse.length > 0, "en utelukket rad har beskrivelsen sin");
sjekk(
  utelukketTurgruppe.tidspunkter.length > 0 || utelukketTurgruppe.steder.length > 0,
  "en utelukket rad har tid eller sted, så innbyggeren kan ringe og spørre"
);

// --- detaljene katalogen har ----------------------------------------------

const alle = [...friluft.anbefalte, ...friluft.andre, ...friluft.utelukkede];
sjekk(alle.some((rad) => rad.pris !== undefined), "prisen følger med i visningen");
sjekk(alle.some((rad) => rad.steder.length > 0), "stedet følger med i visningen");
sjekk(alle.some((rad) => rad.paameldingKreves), "påmeldingskravet følger med");
sjekk(alle.every((rad) => rad.tilbyder.length > 0), "tilbyderen er slått opp til et navn");

// --- påmelding ------------------------------------------------------------

const paameldt = await visning({
  preferanse: preferanse({ grupper: ["friluft"] }),
  registreringer: [{
    registreringId: "r1",
    personId: "person-401",
    aktivitetId: "lavterskel-turgruppe",
    tilbudId: TURGRUPPE,
    navn: "DNT Ringerike Seniorgruppa",
    status: "MOTTATT",
    opprettet: `${IDAG}T10:00:00.000Z`,
    mock: true,
    syntetisk: true
  }]
});
sjekk(
  ![...paameldt.anbefalte, ...paameldt.andre, ...paameldt.utelukkede]
    .some((rad) => rad.aktivitetId === "lavterskel-turgruppe"),
  "en aktivitet hun alt er påmeldt er ikke lenger et forslag"
);

const valgt = await visning({
  preferanse: preferanse({ grupper: ["friluft"] }),
  valgtTilbudId: TURGRUPPE
});
likt(valgt.valgtTilbud?.tilbudId, TURGRUPPE, "et tilbud kan slås opp med ?tilbudId=");
likt(
  (await visning({ preferanse: preferanse({ grupper: ["friluft"] }) })).valgtTilbud,
  null,
  "uten ?tilbudId= er valgtTilbud tomt"
);

console.log(`test-innbyggerportal ok. ${sjekker} sjekker, uten stack og uten modell.`);
