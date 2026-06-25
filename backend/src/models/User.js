import bcrypt from "bcrypt";
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    agency_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agency",
      required: true,
      index: true,
    },
    full_name: {
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
    password_hash: {
      type: String,
      select: false,
    },
    google_id: {
      type: String,
      trim: true,
      default: null,
    },
    role: {
      type: String,
      enum: ["owner", "admin", "analyst", "member"],
      default: "analyst",
      required: true,
    },
    avatar_url: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "users",
  }
);

userSchema.index({ agency_id: 1, role: 1 });

userSchema.virtual("agencyId").get(function () {
  return this.agency_id;
});

userSchema.virtual("agencyId").set(function (value) {
  this.agency_id = value;
});

userSchema.virtual("fullName").get(function () {
  return this.full_name;
});

userSchema.virtual("fullName").set(function (value) {
  this.full_name = value;
});

userSchema.virtual("passwordHash").get(function () {
  return this.password_hash;
});

userSchema.virtual("passwordHash").set(function (value) {
  this.password_hash = value;
});

userSchema.virtual("avatar").get(function () {
  return this.avatar_url;
});

userSchema.virtual("avatar").set(function (value) {
  this.avatar_url = value;
});

userSchema.virtual("googleId").get(function () {
  return this.google_id;
});

userSchema.virtual("googleId").set(function (value) {
  this.google_id = value;
});

userSchema.pre("save", async function () {
  if (!this.isModified("password_hash") || !this.password_hash) return;
  if (this.password_hash.startsWith("$2")) return;

  const salt = await bcrypt.genSalt(10);
  this.password_hash = await bcrypt.hash(this.password_hash, salt);
});

userSchema.methods.comparePassword = async function (password) {
  if (!this.password_hash) return false;
  return bcrypt.compare(password, this.password_hash);
};

export const User = mongoose.models.User || mongoose.model("User", userSchema);

export default User;
