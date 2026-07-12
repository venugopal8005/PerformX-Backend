export const selectAdAccount = async (_req, res) =>
  res.status(410).json({
    selected: false,
    success: false,
    code: "LEGACY_META_FLOW_REMOVED",
    message: "Assign Meta ad accounts to clients from Workspace Settings.",
  });
