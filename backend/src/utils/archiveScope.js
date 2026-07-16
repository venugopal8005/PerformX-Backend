const buildOperationalArchivePredicate = () => ({
  $or: [
    { is_archived: false },
    { is_archived: { $exists: false } },
  ],
});

const buildArchivedPredicate = () => ({ is_archived: true });

const composeScope = (query = {}) => {
  const entries = Object.keys(query || {});
  const archivePredicate = buildOperationalArchivePredicate();
  if (!entries.length) return archivePredicate;

  return {
    $and: [query, archivePredicate],
  };
};

const composeArchivedScope = (query = {}) => {
  const entries = Object.keys(query || {});
  const archivePredicate = buildArchivedPredicate();
  if (!entries.length) return archivePredicate;

  return {
    $and: [query, archivePredicate],
  };
};

export const withOperationalClientScope = (query = {}) => composeScope(query);

export const withOperationalReportScope = (query = {}) => composeScope(query);

export const withArchivedClientScope = (query = {}) =>
  composeArchivedScope(query);

export const withArchivedReportScope = (query = {}) =>
  composeArchivedScope(query);

export const withAllLifecycleClientScope = (query = {}) => ({ ...query });

export const withAllLifecycleReportScope = (query = {}) => ({ ...query });

export const withHistoricalEvidenceScope = (agencyId, query = {}) => ({
  ...query,
  agency_id: agencyId,
});

export const isArchivedDocument = (document) => document?.is_archived === true;

export const operationalArchiveScope = () => buildOperationalArchivePredicate();

export const archivedOnlyScope = () => buildArchivedPredicate();
