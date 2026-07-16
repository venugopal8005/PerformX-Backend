import { User, WorkspaceMember } from "../models/index.js";

const HISTORICAL_MEMBER_STATUSES = ["active", "removed"];

export const loadHistoricalActorMap = async ({ agencyId, userIds = [] }) => {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!agencyId || !ids.length) return new Map();

  const memberships = await WorkspaceMember.find({
    workspace_id: agencyId,
    user_id: { $in: ids },
    status: { $in: HISTORICAL_MEMBER_STATUSES },
  })
    .select("user_id")
    .lean();
  const eligibleIds = [...new Set(memberships.map((membership) => String(membership.user_id)))];
  if (!eligibleIds.length) return new Map();

  const actors = await User.find({ _id: { $in: eligibleIds } })
    .select("_id full_name")
    .lean();
  return new Map(actors.map((actor) => [String(actor._id), actor]));
};
