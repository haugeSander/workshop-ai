/*
 * Kodeverket for et brev: hvilken type det er, og bare det.
 *
 * Her og ikke i sandbox-backend, av samme grunn som varsel.ts og begrunnelse.ts:
 * to tjenester leser det. sandbox-backend bygger brevet, sender det og fører det
 * i ledgeren sin; ai-gateway skriver avsnittene ut fra hvilken type det er. Én av
 * dem kunne eid listen og den andre kopiert den - og da hadde en ny brevtype vært
 * to endringer, hvorav den ene kunne glemmes uten at noe ble rødt.
 */

export const BREVTYPER = ["aapning", "oppfolging"] as const;
export type Brevtype = (typeof BREVTYPER)[number];

/** Om verdien er en kjent brevtype. Vakten på veien inn i ai-gateway, som ikke velger typen selv. */
export function erBrevtype(verdi: unknown): verdi is Brevtype {
  return typeof verdi === "string" && (BREVTYPER as readonly string[]).includes(verdi);
}
