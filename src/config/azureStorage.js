const {
  BlobServiceClient,
  StorageSharedKeyCredential
} = require("@azure/storage-blob");

const accountName = process.env.AZURE_STORAGE_ACCOUNT;
const accountKey = process.env.AZURE_STORAGE_KEY;
const containerName = process.env.AZURE_CONTAINER_NAME;

const credential =
  new StorageSharedKeyCredential(
    accountName,
    accountKey
  );

const blobServiceClient =
  new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential
  );

const containerClient =
  blobServiceClient.getContainerClient(
    containerName
  );

module.exports = {
  containerClient,
  credential,
  accountName
};