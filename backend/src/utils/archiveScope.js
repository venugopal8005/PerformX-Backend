const buildOperationalArchivePredicate = () => ({
  $or: [
    { is_archived: false },
    { is_archived: { $exists: false } },
  ],
});

const composeScope = (query = {}) => {
  const entries = Object.keys(query || {});
  const archivePredicate = buildOperationalArchivePredicate();
  if (!entries.length) return archivePredicate;

  return {
    $and: [query, archivePredicate],
  };
};

export const withOperationalClientScope = (query = {}) => composeScope(query);

export const withOperationalReportScope = (query = {}) => composeScope(query);

export const isArchivedDocument = (document) => document?.is_archived === true;

export const operationalArchiveScope = () => buildOperationalArchivePredicate();
