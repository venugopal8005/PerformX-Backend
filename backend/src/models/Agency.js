import mongoose from "mongoose";

const slugify = (value = "") =>
  value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const assignUniqueSlug = async (agency) => {
  const baseSlug = slugify(agency.name);
  if (!baseSlug) return;

  let nextSlug = baseSlug;
  let suffix = 2;

  while (
    await agency.constructor.exists({
      slug: nextSlug,
      _id: { $ne: agency._id },
    })
  ) {
    nextSlug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  agency.slug = nextSlug;
};

const agencySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "agencies",
  }
);

agencySchema.index({ created_by: 1 });

agencySchema.pre("validate", async function () {
  if (!this.isModified("name") && this.slug) return;
  await assignUniqueSlug(this);
});

agencySchema.pre("save", async function () {
  if (this.slug) return;
  await assignUniqueSlug(this);
});

export const Agency =
  mongoose.models.Agency || mongoose.model("Agency", agencySchema);

export default Agency;
