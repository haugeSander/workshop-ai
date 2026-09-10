// Formen på seniortilbudene i en kommune, og valideringen av den.
//
// Skjemaet er ikke vårt. `data/senioraktiviteter.json` er hentet fra Ringerike
// kommunes eget informasjonsmateriell, med sidereferanser i `kilder` og et
// `status`-felt som skiller det som er lest fra en kilde fra det som er laget for
// sandkassen. Denne modulen leser den formen og validerer den; den skriver den
// ikke om. Et normalisert, kildebelagt datasett er verdt mer enn et flatere ett
// vi hadde funnet på selv.
//
// Kategoriene står i dataene og ikke som et kodeverk her, fordi listen skal kunne
// endres uten en kodeendring. Derfor finnes det ingen `export const KATEGORIER`
// under: et kodeverk i denne mappen ville gjort en ny kategori til en
// kodeendring. Vakten ligger i `scripts/valider-data.ts` i stedet.
//
// Modulen importerer ingenting fra noen app - se `pnpm test:imports`.

const UKEDAGER = [
  "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "loerdag", "soendag"
];

const KLOKKE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const KOMMUNENUMMER = /^[0-9]{4}$/;
const IDENTIFIKATOR = /^[a-z0-9-]+$/;

/**
 * Rullestoladkomst og teleslynge, når kommunen har oppgitt det.
 *
 * `undefined` betyr **ikke oppgitt**, og det er ikke det samme som `false`.
 * Skillet er hele grunnen til at feltet er valgfritt framfor å ha en standard:
 * et hardt filter som leste «ikke oppgitt» som «nei» ville skjult tilbud en
 * rullestolbruker godt kan møte på, og ett som leste det som «ja» ville sendt
 * henne til et hun ikke kommer inn på. Ukjent skal bæres videre som ukjent.
 */
export type Tilgjengelighet = {
  rullestol?: boolean;
  teleslynge?: boolean;
};

export type Tidspunkt = {
  /** Tomt naar tilbudet ikke er bundet til bestemte ukedager. */
  ukedager: string[];
  fraKlokkeslett: string;
  /** Utelatt naar tilbudet ikke har en fast slutt - en tur varer saa lenge den varer. */
  tilKlokkeslett?: string;
  /** Maanedsintervall for et sesongtilbud, som en turgruppe fra april til oktober. */
  sesong?: { fraMaaned: number; tilMaaned: number };
};

export type Tilbud = {
  tilbudId: string;
  /** Peker inn i `tilbydere`. Oppslaget valideres. */
  tilbyderId: string;
  status: string;
  gjennomforing: { former: string[]; tilrettelegging: string[] };
  /** Tomt naar tilbudet ikke har et fast ukentlig tidspunkt - et kurs, en veiledning. */
  tidspunkter: Tidspunkt[];
  /** Utelatt naar det ikke kreves paamelding. */
  paamelding?: { kreves: boolean; kontakt: Record<string, unknown> };
  /** Utelatt inntil kommunen leverer det. Se typen over. */
  tilgjengelighet?: Tilgjengelighet;
};

export type Maalgruppe = {
  maalgruppeId: string;
  gjelderAlle: boolean;
  alder?: { fraAar?: number; tilAar?: number };
  kriterier: { type: string; verdier: string[] }[];
};

export type Seniortilbud = {
  aktivitetId: string;
  navn: string;
  /** Én kategoriverdi. Kommunens egen taksonomi, ikke vår. */
  kategori: string;
  beskrivelse: string;
  /** `kildebasert` eller `syntetisk`. Ikke begrenset her - det er deres kodeverk. */
  opprinnelse: string;
  status: string;
  maalgrupper: Maalgruppe[];
  tilbud: Tilbud[];
  /** Paakrevd naar `opprinnelse` er `kildebasert`, og tom naar den er `syntetisk`. */
  kilder: { tittel: string; aar?: number; side?: number }[];
};

export type Tilbyder = {
  tilbyderId: string;
  navn: string;
  type: string;
  kontakt: Record<string, unknown>;
};

export type Aktivitetskatalog = {
  kommunenavn: string;
  kommunenummer: string;
  schemaVersjon: number;
  aktiviteter: Seniortilbud[];
  tilbydere: Tilbyder[];
};

function krev(betingelse: unknown, melding: string): void {
  if (!betingelse) throw new Error(`Aktivitetskatalogen: ${melding}`);
}

function tekst(verdi: unknown): boolean {
  return typeof verdi === "string" && verdi.trim().length > 0;
}

function lesTilgjengelighet(raa: unknown, hvem: string): Tilgjengelighet | undefined {
  if (raa === undefined || raa === null) return undefined;
  krev(typeof raa === "object" && !Array.isArray(raa),
    `${hvem} har en \`tilgjengelighet\` som ikke er et objekt.`);
  const t = raa as Record<string, unknown>;
  const ut: Tilgjengelighet = {};
  for (const felt of ["rullestol", "teleslynge"] as const) {
    if (t[felt] === undefined) continue;
    krev(typeof t[felt] === "boolean",
      `${hvem} har \`tilgjengelighet.${felt}\` som ikke er true eller false. `
      + "Utelat feltet hvis det ikke er kjent - «ikke oppgitt» er en tredje verdi.");
    ut[felt] = t[felt] as boolean;
  }
  return ut;
}

function lesTidspunkt(raa: unknown, hvem: string, i: number): Tidspunkt {
  const t = (raa ?? {}) as Record<string, unknown>;
  const hvor = `${hvem}, tidspunkt ${i + 1}`;

  // Ukedager er valgfrie: et dagsenter aapent hver ukedag oppgir ingen, og en liste
  // med «alle dagene» ville vaert en paastand kommunen ikke har gjort.
  const ukedager = ((t.ukedager ?? []) as unknown[]).map((d) => {
    krev(UKEDAGER.includes(String(d)),
      `${hvor}: ukedagen «${String(d)}» er ukjent. `
      + `Gyldige: ${UKEDAGER.join(", ")}. Merk loerdag og soendag uten ø.`);
    return String(d);
  });

  krev(KLOKKE.test(String(t.fraKlokkeslett)),
    `${hvor}: \`fraKlokkeslett\` er «${String(t.fraKlokkeslett)}». Forventet TT:MM.`);
  if (t.tilKlokkeslett !== undefined && t.tilKlokkeslett !== null) {
    krev(KLOKKE.test(String(t.tilKlokkeslett)),
      `${hvor}: \`tilKlokkeslett\` er «${String(t.tilKlokkeslett)}». Forventet TT:MM.`);
  }

  let sesong: { fraMaaned: number; tilMaaned: number } | undefined;
  if (t.sesong !== undefined && t.sesong !== null) {
    const raaSesong = t.sesong as Record<string, unknown>;
    for (const felt of ["fraMaaned", "tilMaaned"] as const) {
      const verdi = raaSesong[felt];
      krev(Number.isInteger(verdi) && (verdi as number) >= 1 && (verdi as number) <= 12,
        `${hvor}: \`sesong.${felt}\` er «${String(verdi)}». Forventet et maanedsnummer 1-12.`);
    }
    // Ingen krav om at fra er foer til: en sesong kan gaa over nyttaar.
    sesong = {
      fraMaaned: Number(raaSesong.fraMaaned),
      tilMaaned: Number(raaSesong.tilMaaned)
    };
  }

  return {
    ukedager,
    fraKlokkeslett: String(t.fraKlokkeslett),
    ...(t.tilKlokkeslett === undefined || t.tilKlokkeslett === null
      ? {} : { tilKlokkeslett: String(t.tilKlokkeslett) }),
    ...(sesong ? { sesong } : {})
  };
}

/**
 * Leser katalogen og feiler høyt på hvert avvik, med aktivitetId i meldingen slik
 * at den som leverer filen får vite hvilken rad som er gal.
 *
 * `opprinnelse` og `status` valideres som ikke-tomme tekster og ikke mot en
 * verdiliste: det er kommunens kodeverk, og å låse verdiene her ville gjort en ny
 * status til vår feil framfor deres opplysning.
 */
export function parseAktivitetskatalog(raa: unknown): Aktivitetskatalog {
  krev(raa && typeof raa === "object" && !Array.isArray(raa), "må være et objekt.");
  const k = raa as Record<string, unknown>;

  krev(tekst(k.kommunenavn), "mangler `kommunenavn`.");
  krev(KOMMUNENUMMER.test(String(k.kommunenummer)),
    `har kommunenummeret «${String(k.kommunenummer)}», som ikke er fire siffer.`);
  krev(typeof k.schemaVersjon === "number", "mangler `schemaVersjon`.");

  krev(Array.isArray(k.tilbydere) && (k.tilbydere as unknown[]).length > 0, "mangler `tilbydere`.");
  const tilbydere = (k.tilbydere as unknown[]).map((rad, i) => {
    const t = rad as Record<string, unknown>;
    krev(tekst(t.tilbyderId), `tilbyder nummer ${i + 1} mangler \`tilbyderId\`.`);
    krev(tekst(t.navn), `tilbyderen ${String(t.tilbyderId)} mangler \`navn\`.`);
    krev(tekst(t.type), `tilbyderen ${String(t.tilbyderId)} mangler \`type\`.`);
    return {
      tilbyderId: String(t.tilbyderId),
      navn: String(t.navn),
      type: String(t.type),
      kontakt: (t.kontakt ?? {}) as Record<string, unknown>
    };
  });
  const kjenteTilbydere = new Set(tilbydere.map((t) => t.tilbyderId));
  krev(kjenteTilbydere.size === tilbydere.length, "har samme `tilbyderId` to ganger.");

  krev(Array.isArray(k.aktiviteter) && (k.aktiviteter as unknown[]).length > 0,
    "mangler `aktiviteter`.");
  const sette = new Set<string>();
  const setteTilbud = new Set<string>();

  const aktiviteter = (k.aktiviteter as unknown[]).map((rad, i) => {
    const a = rad as Record<string, unknown>;
    const hvem = tekst(a.aktivitetId) ? String(a.aktivitetId) : `rad nummer ${i + 1}`;

    krev(tekst(a.aktivitetId), `rad nummer ${i + 1} mangler \`aktivitetId\`.`);
    krev(!sette.has(String(a.aktivitetId)), `${hvem} finnes to ganger.`);
    sette.add(String(a.aktivitetId));

    krev(tekst(a.navn), `${hvem} mangler \`navn\`.`);
    krev(tekst(a.beskrivelse), `${hvem} mangler \`beskrivelse\`.`);
    krev(tekst(a.opprinnelse), `${hvem} mangler \`opprinnelse\`.`);
    krev(tekst(a.status), `${hvem} mangler \`status\`.`);
    krev(tekst(a.kategori), `${hvem} mangler \`kategori\`.`);
    krev(IDENTIFIKATOR.test(String(a.kategori)),
      `${hvem} har kategorien «${String(a.kategori)}». `
      + "En kategoriverdi er en identifikator: små bokstaver, tall og bindestrek.");

    krev(Array.isArray(a.maalgrupper) && (a.maalgrupper as unknown[]).length > 0,
      `${hvem} mangler \`maalgrupper\`. Uten en målgruppe kan tilbudet ikke rettes mot noen.`);
    const maalgrupper = (a.maalgrupper as unknown[]).map((rad2, j) => {
      const m = rad2 as Record<string, unknown>;
      krev(tekst(m.maalgruppeId), `${hvem}, målgruppe ${j + 1}: mangler \`maalgruppeId\`.`);
      krev(typeof m.gjelderAlle === "boolean",
        `${hvem}, målgruppen ${String(m.maalgruppeId)}: \`gjelderAlle\` må være true eller false.`);
      const alder = m.alder as Record<string, unknown> | undefined;
      if (alder) {
        for (const felt of ["fraAar", "tilAar"] as const) {
          if (alder[felt] === undefined) continue;
          krev(Number.isInteger(alder[felt]) && (alder[felt] as number) >= 0,
            `${hvem}, målgruppen ${String(m.maalgruppeId)}: \`alder.${felt}\` må være et helt år.`);
        }
        if (alder.fraAar !== undefined && alder.tilAar !== undefined) {
          krev((alder.fraAar as number) <= (alder.tilAar as number),
            `${hvem}, målgruppen ${String(m.maalgruppeId)}: fraAar er høyere enn tilAar.`);
        }
      }
      // En maalgruppe som ikke gjelder alle maa peke ut noen: enten en aldersgrense
      // eller et kriterium. Uten begge retter tilbudet seg mot ingen.
      if (m.gjelderAlle === false) {
        krev(alder !== undefined || ((m.kriterier ?? []) as unknown[]).length > 0,
          `${hvem}, målgruppen ${String(m.maalgruppeId)}: \`gjelderAlle\` er false, men `
          + "det står verken `alder` eller `kriterier`. Da retter den seg mot ingen.");
      }
      const kriterier = ((m.kriterier ?? []) as unknown[]).map((rad3, n) => {
        const c = rad3 as Record<string, unknown>;
        krev(tekst(c.type), `${hvem}, målgruppe ${j + 1}, kriterium ${n + 1}: mangler \`type\`.`);
        krev(Array.isArray(c.verdier) && (c.verdier as unknown[]).length > 0,
          `${hvem}, målgruppe ${j + 1}, kriteriet ${String(c.type)}: mangler \`verdier\`.`);
        return { type: String(c.type), verdier: (c.verdier as unknown[]).map(String) };
      });
      return {
        maalgruppeId: String(m.maalgruppeId),
        gjelderAlle: Boolean(m.gjelderAlle),
        ...(alder ? { alder: alder as { fraAar?: number; tilAar?: number } } : {}),
        kriterier
      };
    });

    krev(Array.isArray(a.tilbud) && (a.tilbud as unknown[]).length > 0,
      `${hvem} mangler \`tilbud\`. En aktivitet uten et tilbud kan ingen møte på.`);
    const tilbud = (a.tilbud as unknown[]).map((rad2, j) => {
      const t = rad2 as Record<string, unknown>;
      const hvemTilbud = tekst(t.tilbudId) ? String(t.tilbudId) : `${hvem}, tilbud ${j + 1}`;
      krev(tekst(t.tilbudId), `${hvem}, tilbud ${j + 1}: mangler \`tilbudId\`.`);
      krev(!setteTilbud.has(String(t.tilbudId)), `Tilbudet ${hvemTilbud} finnes to ganger.`);
      setteTilbud.add(String(t.tilbudId));
      krev(tekst(t.status), `${hvemTilbud} mangler \`status\`.`);
      krev(kjenteTilbydere.has(String(t.tilbyderId)),
        `${hvemTilbud} peker på tilbyderen «${String(t.tilbyderId)}», som ikke står i \`tilbydere\`.`);

      const g = (t.gjennomforing ?? {}) as Record<string, unknown>;
      krev(Array.isArray(g.former) && (g.former as unknown[]).length > 0,
        `${hvemTilbud} mangler \`gjennomforing.former\`.`);
      // Utelatt paamelding betyr at det ikke kreves noe. Star den der, maa `kreves`
      // vaere en boolsk verdi - halvveis utfylt er verre enn utelatt.
      const p = t.paamelding as Record<string, unknown> | undefined;
      if (p !== undefined && p !== null) {
        krev(typeof p.kreves === "boolean",
          `${hvemTilbud} har en \`paamelding\` uten at \`kreves\` er true eller false.`);
      }

      return {
        tilbudId: String(t.tilbudId),
        tilbyderId: String(t.tilbyderId),
        status: String(t.status),
        gjennomforing: {
          former: (g.former as unknown[]).map(String),
          tilrettelegging: ((g.tilrettelegging ?? []) as unknown[]).map(String)
        },
        tidspunkter: ((t.tidspunkter ?? []) as unknown[])
          .map((x, n) => lesTidspunkt(x, hvemTilbud, n)),
        ...(p ? { paamelding: {
          kreves: Boolean(p.kreves),
          kontakt: (p.kontakt ?? {}) as Record<string, unknown>
        } } : {}),
        ...(() => {
          const tg = lesTilgjengelighet(t.tilgjengelighet, hvemTilbud);
          return tg ? { tilgjengelighet: tg } : {};
        })()
      };
    });

    // Invarianten i kommunens egne data, og verdt aa holde: et kildebasert tilbud
    // baerer sidereferansen sin, og et syntetisk eksempel skal ikke kunne skaffe seg
    // en. `krever-verifisering` betyr at et menneske fortsatt skal sjekke raden, og
    // da maa det vaere synlig hva den hviler paa.
    const erKildebasert = String(a.opprinnelse) === "kildebasert";
    const raaKilder = (a.kilder ?? []) as unknown[];
    krev(Array.isArray(raaKilder), `${hvem} har en \`kilder\` som ikke er en liste.`);
    if (erKildebasert) {
      krev(raaKilder.length > 0,
        `${hvem} er kildebasert, men mangler \`kilder\`. Et tilbud vi foreslår en `
        + "innbygger skal kunne spores tilbake til der det er lest.");
    } else {
      krev(raaKilder.length === 0,
        `${hvem} har \`opprinnelse\` «${String(a.opprinnelse)}» og likevel `
        + `${raaKilder.length} kilder. Et syntetisk eksempel skal ikke bære en referanse `
        + "det ikke stammer fra.");
    }
    const kilder = raaKilder.map((rad2, j) => {
      const c = rad2 as Record<string, unknown>;
      krev(tekst(c.tittel), `${hvem}, kilde ${j + 1}: mangler \`tittel\`.`);
      return {
        tittel: String(c.tittel),
        ...(c.aar === undefined ? {} : { aar: Number(c.aar) }),
        ...(c.side === undefined ? {} : { side: Number(c.side) })
      };
    });

    return {
      aktivitetId: String(a.aktivitetId),
      navn: String(a.navn),
      kategori: String(a.kategori),
      beskrivelse: String(a.beskrivelse),
      opprinnelse: String(a.opprinnelse),
      status: String(a.status),
      maalgrupper,
      tilbud,
      kilder
    };
  });

  return {
    kommunenavn: String(k.kommunenavn),
    kommunenummer: String(k.kommunenummer),
    schemaVersjon: Number(k.schemaVersjon),
    aktiviteter,
    tilbydere
  };
}

/** Kategoriverdiene katalogen faktisk bruker. Domenet grupperingen måles mot. */
export function kategoriverdier(katalog: Aktivitetskatalog): string[] {
  return [...new Set(katalog.aktiviteter.map((aktivitet) => aktivitet.kategori))].sort();
}

/**
 * Hvor mange tilbud som mangler rullestol- eller teleslyngeopplysning.
 *
 * Finnes for at mangelen skal være tellbar framfor stille: så lenge kommunen ikke
 * har levert feltet, kan ikke det harde filteret på rullestol slå inn, og da skal
 * det være mulig å se hvor stor den luken er.
 */
export function tilbudUtenTilgjengelighet(katalog: Aktivitetskatalog): number {
  return katalog.aktiviteter
    .flatMap((aktivitet) => aktivitet.tilbud)
    .filter((tilbud) => tilbud.tilgjengelighet?.rullestol === undefined
      || tilbud.tilgjengelighet?.teleslynge === undefined).length;
}
