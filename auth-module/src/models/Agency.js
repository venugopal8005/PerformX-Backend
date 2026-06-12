import { slugify } from "../utils/slugify.js";

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

export const createAgencyModel = (mongoose) => {
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
      createdAt: {
        type: Date,
        default: Date.now,
      },
    },
    {
      timestamps: true,
      collection: "agencies",
    }
  );

  agencySchema.pre("validate", async function () {
    if (!this.isModified("name") && this.slug) return;
    await assignUniqueSlug(this);
  });

  agencySchema.pre("save", async function () {
    if (this.slug) return;
    await assignUniqueSlug(this);
  });

  return mongoose.models.Agency || mongoose.model("Agency", agencySchema);
};
