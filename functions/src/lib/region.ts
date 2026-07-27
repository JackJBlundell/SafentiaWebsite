// ============================================================================
// The single deployment region for every Safentia Function.
//
// Why one constant: the RTDB instance is provisioned in europe-west1 (see the
// FIREBASE_DATABASE_URL in .env.example), so co-locating the Functions removes a
// cross-region hop on every database read and write and keeps tenant data inside
// the EU for the data-residency expectations of a UK fire-safety product. Stating
// it once means a region move is a one-line change, never a per-function edit.
// ============================================================================

export const REGION = 'europe-west1' as const;
