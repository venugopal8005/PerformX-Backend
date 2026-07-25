import mongoose from "mongoose";

const evaluationReconciliationCheckpointSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    agency_id: { type: mongoose.Schema.Types.ObjectId, ref: "Agency", default: null },
    cursor: { type: mongoose.Schema.Types.ObjectId, ref: "Intervention", default: null },
    cycle_started_at: { type: Date, default: null },
    last_attempt_at: { type: Date, default: null },
    last_completed_at: { type: Date, default: null },
    processed_count: { type: Number, min: 0, default: 0 },
    failed_count: { type: Number, min: 0, default: 0 },
    revision: { type: Number, min: 0, default: 0 },
  },
  {
    timestamps: true,
    collection: "evaluation_reconciliation_checkpoints",
    strict: "throw",
    autoIndex: false,
    autoCreate: false,
  }
);

export const EvaluationReconciliationCheckpoint =
  mongoose.models.EvaluationReconciliationCheckpoint ||
  mongoose.model("EvaluationReconciliationCheckpoint", evaluationReconciliationCheckpointSchema);

export default EvaluationReconciliationCheckpoint;
