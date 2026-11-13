// Pure response metadata, shared by handlers without importing database services.
export const changeWarnings = [
  { code: 'summary_only', message: 'Only product.summary changes; metadata, features and technical design are preserved.', sections: ['meta', 'features', 'architecture'] },
  { code: 'artifact_freshness_snapshot', message: 'Artifact freshness is a server snapshot, not regeneration. Refetch tracked artifact data after changes or publication; frontend exports still require S5 integration.', sections: [] },
];
