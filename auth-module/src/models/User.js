import bcrypt from "bcrypt";

export const createUserModel = (mongoose) => {
  const userSchema = new mongoose.Schema(
    {
      fullName: {
        type: String,
        required: true,
        trim: true,
      },
      email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
      },
      passwordHash: {
        type: String,
        select: false,
      },
      googleId: {
        type: String,
        trim: true,
      },
      avatar: {
        type: String,
        trim: true,
      },
      role: {
        type: String,
        enum: ["owner", "member"],
        default: "owner",
      },
      agencyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Agency",
        required: true,
      },
      createdAt: {
        type: Date,
        default: Date.now,
      },
    },
    {
      timestamps: true,
      collection: "users",
    }
  );

  userSchema.pre("save", async function () {
    if (!this.isModified("passwordHash") || !this.passwordHash) return;

    const salt = await bcrypt.genSalt(10);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
  });

  userSchema.methods.comparePassword = async function (candidatePassword) {
    if (!this.passwordHash) return false;
    return bcrypt.compare(candidatePassword, this.passwordHash);
  };

  return mongoose.models.User || mongoose.model("User", userSchema);
};
