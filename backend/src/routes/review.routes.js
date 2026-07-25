import { Router } from "express";
import { protect } from "auth-module";
import {
  acknowledgeReview, createReviewItemIntervention, getReviewActions, getReviewItem, getReviewItems,
  getReviewSummary, interpretReview, snoozeReview,
} from "../controllers/review.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";

const router = Router();
router.get("/summary", protect, requireWorkspaceMember, getReviewSummary);
router.get("/", protect, requireWorkspaceMember, getReviewItems);
router.get("/:reviewItemId/actions", protect, requireWorkspaceMember, getReviewActions);
router.post("/:reviewItemId/acknowledge", protect, requireWorkspaceMember, acknowledgeReview);
router.post("/:reviewItemId/snooze", protect, requireWorkspaceMember, snoozeReview);
router.post("/:reviewItemId/review", protect, requireWorkspaceMember, interpretReview);
router.post("/:reviewItemId/interventions", protect, requireWorkspaceMember, createReviewItemIntervention);
router.get("/:reviewItemId", protect, requireWorkspaceMember, getReviewItem);
export default router;
