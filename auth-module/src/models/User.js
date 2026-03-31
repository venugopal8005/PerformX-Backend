import bcrypt from "bcrypt";

export const createUserModel = (mongoose) => {
  const userSchema = new mongoose.Schema(
    {
      email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
      },
      password: {
        type: String,
        required: true,
        minlength: 6,
      },
      displayName:{
        type: String,
        required:true,
      }
    },
    {
      timestamps: true,
    }
  );

  // 🔐 Hash password before save
  userSchema.pre("save", async function () {
    if (!this.isModified("password")) return;

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  });

  // 🔍 Compare passwords
  userSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
  };

  // ✅ Use the PROVIDED mongoose instance
  return mongoose.models.User || mongoose.model("User", userSchema);
};
