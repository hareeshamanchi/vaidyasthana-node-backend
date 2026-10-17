const {
  BlobServiceClient,
  StorageSharedKeyCredential,
} = require("@azure/storage-blob");

const getAccountName = () => process.env.AZURE_STORAGE_ACCOUNT || "";
const getAccountKey = () => process.env.AZURE_STORAGE_KEY || "";
const getContainerName = () => process.env.AZURE_CONTAINER_NAME || "medical-reports";

const isAzureStorageConfigured = () => {
  return Boolean(getAccountName() && getAccountKey());
};

let _credential = null;
let _blobServiceClient = null;
let _containerClient = null;

const getCredential = () => {
  if (!isAzureStorageConfigured()) {
    return null;
  }
  if (!_credential) {
    _credential = new StorageSharedKeyCredential(
      getAccountName(),
      getAccountKey()
    );
  }
  return _credential;
};

const getBlobServiceClient = () => {
  if (!isAzureStorageConfigured()) {
    return null;
  }
  if (!_blobServiceClient) {
    const cred = getCredential();
    _blobServiceClient = new BlobServiceClient(
      `https://${getAccountName()}.blob.core.windows.net`,
      cred
    );
  }
  return _blobServiceClient;
};

const getContainerClient = () => {
  if (!isAzureStorageConfigured()) {
    return null;
  }
  if (!_containerClient) {
    const serviceClient = getBlobServiceClient();
    if (serviceClient) {
      _containerClient = serviceClient.getContainerClient(getContainerName());
    }
  }
  return _containerClient;
};

// Export safe helpers and backward-compatible getters
module.exports = {
  isAzureStorageConfigured,
  getCredential,
  getBlobServiceClient,
  getContainerClient,
  get containerClient() {
    return getContainerClient();
  },
  get credential() {
    return getCredential();
  },
  get accountName() {
    return getAccountName();
  },
  get containerName() {
    return getContainerName();
  },
};