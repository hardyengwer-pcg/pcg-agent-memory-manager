import { appendVerbatimEvidence, type VerbatimEvidenceInput } from '../../verbatim-evidence-ledger.ts';

export function recordVerbatimEvidence(inputs: VerbatimEvidenceInput[]): void {
  try {
    const records = appendVerbatimEvidence(inputs);
    if (records.length > 0) console.log(`[Evidence Ledger] ${records.length} neue unveränderte Quelle(n) gespeichert.`);
  } catch (error: any) {
    console.warn('[Evidence Ledger] Speicherung übersprungen:', error?.message || error);
  }
}
