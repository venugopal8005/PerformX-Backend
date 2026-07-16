export const MONGOOSE_CONNECTION_OPTIONS = Object.freeze({
  autoIndex: false,
  autoCreate: false,
});

export const connectMongooseWithIndexManagementDisabled = ({
  mongooseInstance,
  uri,
} = {}) => mongooseInstance.connect(uri, { ...MONGOOSE_CONNECTION_OPTIONS });
