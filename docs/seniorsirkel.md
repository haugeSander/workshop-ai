# Seniorsirkel: seniortilbudene i Ringerike

Casen svarer på ett spørsmål for en innbygger over 62 i Ringerike: *hva finnes for meg
her?* Den henter det kommunen tilbyr, sjekker hva innbyggeren har rett til, spør om det
vi ikke vet, og foreslår tilbud som passer.

Katalogen er `data/senioraktiviteter.json`. Skjemaet er **kommunens eget**, ikke vårt:
det er hentet fra Ringerikes informasjonsmateriell, med sidereferanser i `kilder` og et
`status`-felt som skiller det som er lest fra en kilde fra det som er laget for
sandkassen. `apps/shared/senioraktivitet.ts` leser den formen og validerer den. Den
skriver den ikke om.

## Hva casen dekker

Katalogen er bredere enn en sosial klubb. Den har `matombringing`,
`bolig-og-hverdagsmestring` og `psykisk-helse-og-mestring` ved siden av turgrupper og
seniorkino - altså hele kommunens seniortilbud. Det er med vilje: for en innbyggerportal
er «hva finnes for meg» et bedre spørsmål enn «finnes det en klubb».

## To lister, og hvorfor de ikke er like

**Kommunens kategorier** står i katalogen. De er en tjenestetaksonomi:
`friluftsliv-og-trening`, `digital-mestring`, `psykisk-helse-og-mestring`.

**Interessegruppene** står i `data/seniorsirkel-grupper.json`. De er det innbyggeren blir
spurt om:

| `verdi` | `label` | Kommunens kategorier |
|---|---|---|
| `moeteplasser` | Møteplasser og sosialt fellesskap | `dagaktivitet`, `kultur-og-fellesskap` |
| `friluft` | Friluft og fysisk aktivitet | `friluftsliv-og-trening`, `helse-og-trening` |
| `kultur` | Kultur, læring og opplevelser | `kultur-og-fellesskap`, `digital-mestring` |
| `frivillig` | Bidra i frivillig arbeid | `frivillighet-og-sosial-stotte` |
| `hverdagsmestring` | Hjelp og mestring i hverdagen | `mat-og-ernaering`, `bolig-og-hverdagsmestring`, `psykisk-helse-og-mestring` |

Grunnen til at de er to lister: en innbygger skal ikke bli spurt hvilken tjenestekategori
et tilbud er sortert under. En kategori kan ligge i flere grupper - en sangkafé er både en
møteplass og kultur.

`scripts/valider-data.ts` måler de to mot hverandre, begge veier. En kategori uten gruppe
er et tilbud ingen interesse kan treffe; en gruppe som peker på en kategori katalogen ikke
har, er en valgmulighet uten innhold. Begge feilene er stille, så begge sjekkes.

**Legger du til en kategori, må den inn i en gruppe.** Det er en dataendring, ikke en
kodeendring. Det finnes med vilje ikke noe kodeverk for kategorier i `apps/shared`.

## Skjemaet

```json
{
  "kommunenavn": "Ringerike",
  "kommunenummer": "3305",
  "schemaVersjon": 1,
  "aktiviteter": [
    {
      "aktivitetId": "seniorkino",
      "navn": "Seniorkino",
      "kategori": "kultur-og-fellesskap",
      "beskrivelse": "Kinoforestilling på dagtid, med dempet lyd.",
      "opprinnelse": "kildebasert",
      "status": "krever-verifisering",
      "maalgrupper": [
        { "maalgruppeId": "voksent-publikum", "gjelderAlle": false, "alder": { "fraAar": 60 } }
      ],
      "tilbud": [
        {
          "tilbudId": "seniorkino-honefoss-kino",
          "tilbyderId": "honefoss-kino",
          "status": "krever-verifisering",
          "gjennomforing": { "former": ["kino"], "tilrettelegging": ["dempet-lyd", "dagtid"] },
          "tidspunkter": [{ "ukedager": ["tirsdag"], "fraKlokkeslett": "12:00" }],
          "tilgjengelighet": { "rullestol": true, "teleslynge": true }
        }
      ],
      "kilder": [{ "tittel": "Informasjonsbrosjyre senior i Ringerike", "aar": 2024, "side": 7 }]
    }
  ],
  "tilbydere": [
    { "tilbyderId": "honefoss-kino", "navn": "Hønefoss kino", "type": "privat", "kontakt": {} }
  ]
}
```

### Hva som er påkrevd

| Felt | Krav |
|---|---|
| `aktivitetId`, `tilbudId` | Unike i hele filen |
| `navn`, `beskrivelse`, `kategori`, `opprinnelse`, `status` | Påkrevd. `kategori` er én verdi, ikke en liste |
| `maalgrupper` | Minst én. `gjelderAlle: false` krever `alder` eller `kriterier` |
| `tilbud` | Minst ett. `tilbyderId` må finnes i `tilbydere` |
| `tidspunkter` | Valgfritt. Et kurs har ikke et fast ukentlig tidspunkt |
| `tidspunkter[].ukedager` | Valgfritt. Utelatt betyr ikke bundet til bestemte dager |
| `tidspunkter[].fraKlokkeslett` | `TT:MM`, påkrevd når det står et tidspunkt |
| `tidspunkter[].tilKlokkeslett` | Valgfritt. En tur varer så lenge den varer |
| `tidspunkter[].sesong` | Valgfritt, `{fraMaaned, tilMaaned}` 1-12. Kan gå over nyttår |
| `paamelding` | Valgfritt. Utelatt betyr at det ikke kreves |
| `kilder` | Påkrevd når `opprinnelse` er `kildebasert`, og **tom** når den er `syntetisk` |

Den siste er en invariant i kommunens egne data, og verdt å holde: et kildebasert tilbud
bærer sidereferansen sin, og et syntetisk eksempel skal ikke kunne skaffe seg en.
`krever-verifisering` betyr at et menneske fortsatt skal se på raden, og da må det være
synlig hva den hviler på.

### Ukedag skrives uten æ, ø og å

```
mandag  tirsdag  onsdag  torsdag  fredag  loerdag  soendag
```

`loerdag` og `soendag`, ikke `lørdag` og `søndag`. Det er identifikatorer, og
identifikatorer i dette repoet translittereres. Teksten en innbygger leser gjør det ikke -
se [språkreglene i `AGENTS.md`](../AGENTS.md).

## Tilgjengelighet har tre tilstander, ikke to

```json
"tilgjengelighet": { "rullestol": true, "teleslynge": false }
```

`true`, `false` - og **utelatt**, som betyr *ikke oppgitt*. De tre er forskjellige, og
skillet er hele grunnen til at feltet er valgfritt framfor å ha en standardverdi:

- Et hardt filter som leste «ikke oppgitt» som **nei** ville skjult tilbud en
  rullestolbruker godt kan møte på.
- Ett som leste det som **ja** ville sendt henne til et hun ikke kommer inn på.

Ukjent bæres derfor videre som ukjent, og vises som «adkomst ikke oppgitt» framfor å bli
gjettet. `spisevenn` er utelatt i katalogen i dag, fordi en frivillig som kommer hjem til
deg ikke er kommunens adkomst å svare for. `pnpm test` krever at alle tre tilstandene
finnes i katalogen, ellers er en gren i skåringen død kode.

Fritekst i `gjennomforing.tilrettelegging` er **ikke** det samme: `dempet-lyd` og
`skyss-ved-behov` sier noe nyttig, men et hardt filter må hvile på et felt som betyr ja
eller nei.

## Hvordan et tilbud blir foreslått

Skåringen er deterministisk og ligger i kode: `apps/sandbox-backend/src/seniorsirkel.ts`.
Modellen får de best skårende tilbudene og begrunnelseskodene, og skriver hvorfor de
passer. **Den rangerer ikke, og avgjør ikke.** Modulen er ren og synkron - katalogen
kommer inn som en parameter - så et utfall kan pinnes mot fixturen uten en eneste
kjørende tjeneste. `pnpm test:seniorsirkel` gjør det, og den kjører i CI.

| | Virkning |
|---|---|
| `kommunenummer` | Hardt krav |
| `tilgjengelighet.rullestol` | Hardt krav når innbyggeren har oppgitt behov, og bare når feltet er `false`. Ikke oppgitt filtrerer ikke |
| `tilgjengelighet.teleslynge` | Mykt signal. Filtrering her ville skjult nesten hele katalogen |
| `kategori` | Poeng når kategorien ligger i en gruppe innbyggeren valgte |
| `maalgrupper` | Poeng når innbyggeren treffer målgruppen tilbudet er rettet mot |

### Begrunnelseskodene

`scoreTilbud(profil, aktivitet, tilbud)` svarer med `{score, begrunnelseskoder}`, og
kodene er det modellen skriver ut av. De er en union i koden, ikke fritekst: en
skrivefeil ville gitt en kode ingen prompt kjenner igjen, og det hadde vist seg først
når en innbygger nådde den.

| Kode | Poeng | Når |
|---|---|---|
| `treffer_interesse` | 10 | Kategorien ligger i en gruppe innbyggeren valgte |
| `utenfor_interessene` | 0 | Den gjør ikke det, og interesser var oppgitt |
| `i_maalgruppen` | 4 | Alderen ligger innenfor en målgruppe tilbudet retter seg mot |
| `gjelder_alle` | 2 | Målgruppen gjelder alle |
| `utenfor_maalgruppen` | 0 | Alderen ligger utenfor |
| `maalgruppe_ukjent` | 0 | Målgruppen kan ikke måles mot profilen |
| `rullestoladkomst` | 3 | Behov oppgitt, og tilbudet har adkomst |
| `rullestol_ikke_oppgitt` | 0 | Behov oppgitt, men kommunen har ikke svart |
| `mangler_rullestoladkomst` | - | **Hardt krav.** Behov oppgitt, og tilbudet har det ikke |
| `teleslynge` | 3 | Ønske oppgitt, og tilbudet har teleslynge |
| `teleslynge_mangler` | 0 | Ønske oppgitt, og tilbudet har det ikke. Utelukker ikke |
| `teleslynge_ikke_oppgitt` | 0 | Ønske oppgitt, men kommunen har ikke svart |
| `utenfor_kommunen` | - | **Hardt krav.** Katalogen gjelder en annen kommune |

**Skåren skrives aldri for hånd.** Den er summen av vektene til kodene som slo til, og et
hardt krav gir `score: null` framfor null poeng. De to er ikke det samme: et tilbud uten
et eneste treff er fortsatt et tilbud innbyggeren kan møte på, mens en dør en rullestol
ikke kommer gjennom ikke er et tilbud med lavere skår. Testen måler summen mot delene på
hver eneste rad, så et poengtall skrevet inn et annet sted i modulen blir rødt.

### Ukjent er ikke bom, og det gjelder også målgruppen

Katalogen bærer ukjent tilgjengelighet som ukjent, og skåringen gjør det samme - det er
det tre av kodene over handler om. Den samme regelen gjelder målgruppen: `spisevenn` har
en målgruppe som bare peker ut et kriterium («har behov for sosial kontakt»), og profilen
bærer ikke behov. Da er svaret `maalgruppe_ukjent`, ikke `utenfor_maalgruppen`. En
skåring som leste det som bom ville skjult tilbudet for den som trenger det mest.

Er alderen ikke oppgitt i det hele tatt - portalen kan spørre «hva finnes for meg» uten å
ha personen - er hver aldersmålgruppe ukjent av samme grunn.

### De utelukkede blir stående

`rangerTilbud(profil, katalog)` svarer med både `forslag` og `utelukkede`, og summen av
dem er `antallVurdert`. En innbygger som har oppgitt at hun bruker rullestol har krav på
å få vite at det finnes turgrupper hun ikke kommer inn på, framfor at de forsvinner uten
spor. Rekkefølgen er skår, så `aktivitetId`, så `tilbudId`: de to siste er der for at to
kjøringer av samme data skal gi samme liste.

Alderen regnes med `alderVed` mot `satser.gjelderFra` - den samme datoen vilkåret bruker,
slik at katalogens målgrupper og retten til ordningen måler mot samme dag. Ingen
`new Date()`; se datoavsnittet i [`AGENTS.md`](../AGENTS.md).

## Ruten

```
GET /api/seniorsirkel/forslag?personId=person-401&grupper=friluft,kultur&rullestol=true
```

Katalogoppføring i `apps/sandbox-backend/src/ressurser.ts`, så den er samtidig et
HTTP-endepunkt og et gyldig `DATA_FETCH`-mål. `tilgang` er egne-data: katalogen er
offentlig, men alderen, bostedskommunen og tilretteleggingsbehovet i svaret er
innbyggerens. Den krever **ikke** samtykke - samtykket i prosessen gjelder
kontaktopplysningene, som denne ruten ikke rører.

**Kommunen og alderen leses fra registeret, aldri fra spørringen.** En kaller som
kunne oppgi kommunen sin selv, hadde gjort det harde kravet til en innstilling.

| Parameter | |
|---|---|
| `personId` | Påkrevd. Uten den vet ruten verken hvilken kommune eller hvilken alder |
| `grupper` | Kommaliste av gruppeverdier. En ukjent verdi gir 400, ikke et tomt svar |
| `rullestol`, `teleslynge` | `true`/`false`. **Utelatt er den tredje tilstanden** |

Portalen kaller ruten med spørreparametere; prosessmotoren kaller den med en økt bak
seg og kan la svarene komme derfra. De to leses av den samme funksjonen -
`byggProfilFraKilder` - framfor av to som skal oppføre seg likt, og spørringen vinner
der begge svarer. Fra økten er det **feltnavnet** som teller og ikke steg-id-en: et
steg som heter `interesser` duger, og det gjør også et felt som heter `interesser`
inne i svaret på et steg som heter noe annet.

Et `ja-nei`-felt har tre verdier, og «Vet ikke» blir til ikke oppgitt - samme regel
som katalogen følger. Peker et `DATA_FETCH`-steg på et spørsmål som ikke er besvart,
står plassholderen igjen i URL-en; ruten sier da at steget ikke er besvart, framfor å
lese `{svar.interesser}` som et gruppenavn og skylde på innbyggeren.

`pnpm test:kontrakt` treffer ruten seks ganger, blant annet med en innbyggers token
mot en annens profil - det er egne-data-vakten, og ingenting annet pinner den.

## Hvilken fil som leses

`SENIORAKTIVITET_DATA_FILE`, med `senioraktiviteter.json` som standard.
`data/senioraktiviteter.seed.json` er en fixtur på tre aktiviteter som testene peker på,
og den er **generert som et utvalg fra den virkelige katalogen** framfor skrevet for
hånd - da kan den ikke komme ut av form med skjemaet den skal pinne. Mønsteret er det
samme som `MATRIKKEL_DATA_FILE` i [`apps/matrikkel-mock`](../apps/matrikkel-mock/README.md).

Vil du prøve din egen versjon uten å røre repoet, legger du den i `state/` - `readJson`
leter der først. Se [«Egne testdata» i `docs/bygg-selv.md`](bygg-selv.md). Men merk to
ting: `pnpm test` validerer `data/`, ikke `state/`, og `./start.sh --reset` tømmer
`state/`. Data som skal valideres og deles hører i `data/`.

## Test filen din

```bash
node scripts/valider-data.ts
SENIORAKTIVITET_DATA_FILE=min-katalog.json node scripts/valider-data.ts
```

Feiler den, navngir meldingen raden og hva som er galt.

## Aldersgrensen står i satsene, ikke i katalogen

Katalogen har `maalgrupper[].alder.fraAar`, og flere tilbud sier 60. Retten til
seniorsirkelen avgjøres likevel av ordningen `seniorsirkel` i `data/satser.json`, som
måler alder mot `malgruppeFraAar` på tilbudet i `data/tjenestetilbud.json` - 62 i
Ringerike.

De to er ikke i konflikt, men de er to tall: kommunens egen målgruppe for et enkelt tilbud,
og vilkåret for ordningen. Vilkåret er det som avgjør, og det er
`apps/sandbox-backend/src/vilkaar.ts` som eier det. Katalogens aldersfelt er et
skåringssignal, ikke et vedtak.
