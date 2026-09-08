export class BaseAdapter {
  constructor(account) {
    if (new.target === BaseAdapter) {
      throw new Error('BaseAdapter is abstract and cannot be instantiated directly');
    }
    this.account = account;
  }

  async listFiles(path = '/') {
    throw new Error('listFiles() must be implemented by subclass');
  }

  async getFileDetails(id) {
    throw new Error('getFileDetails() must be implemented by subclass');
  }

  async getDownloadStream(id) {
    throw new Error('getDownloadStream() must be implemented by subclass');
  }

  async uploadFile(name, body, size) {
    throw new Error('uploadFile() must be implemented by subclass');
  }

  async renameFile(id, name) {
    throw new Error('renameFile() must be implemented by subclass');
  }

  async deleteFile(id) {
    throw new Error('deleteFile() must be implemented by subclass');
  }

  async createFolder(name, parentId) {
    throw new Error('createFolder() must be implemented by subclass');
  }

  async setFileStarred(id, starred) {
    throw new Error('setFileStarred() must be implemented by subclass');
  }
}
