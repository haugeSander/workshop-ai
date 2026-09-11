/*
 * Hvorfor et seniortilbud skårer som det gjør: kodeverket, og bare det.
 *
 * Her og ikke i seniorsirkel.ts, fordi to tjenester leser listen.
 * `sandbox-backend` produserer kodene i `rangerTilbud`, og `ai-gateway` skriver
 * setningen innbyggeren leser ut av dem. Én av dem kunne eid listen og den andre
 * kopiert den - og da hadde en ny kode vært to endringer, hvorav den ene kunne
 * glemmes uten at noe ble rødt. Det er den samme grunnen `varsel.ts` står her.
 *
 * **Vektene og de harde kravene blir igjen i `seniorsirkel.ts`.** De er regelen,
 * og regelen hører i tjenesten som avgjør. Her ligger bare ordene.
 *
 * Kodene er wire: de går ut over HTTP og inn i en prompt, så de er en union og
 * ikke `string`. En skrivefeil ville gitt en kode ingen prompt kjenner igjen, og
 * det ville vist seg først når en innbygger nådde den.
 */

export const BEGRUNNELSESKODER = [
  "treffer_interesse",
  "utenfor_interessene",
  "i_maalgruppen",
  "gjelder_alle",
  "utenfor_maalgruppen",
  "maalgruppe_ukjent",
  "rullestoladkomst",
  "rullestol_ikke_oppgitt",
  "mangler_rullestoladkomst",
  "teleslynge",
  "teleslynge_mangler",
  "teleslynge_ikke_oppgitt",
  "utenfor_kommunen"
] as const;
export type Begrunnelseskode = (typeof BEGRUNNELSESKODER)[number];

/** Om verdien er en kjent kode. Vakten på veien inn i `ai-gateway`, som ikke skårer selv. */
export function erBegrunnelseskode(verdi: unknown): verdi is Begrunnelseskode {
  return typeof verdi === "string"
    && (BEGRUNNELSESKODER as readonly string[]).includes(verdi);
}
