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

  async copyFile(fileRecord, destRemoteId) {
    const stream = await this.getDownloadStream(fileRecord);
    const size = fileRecord.size || undefined;
    return this.uploadStream({
      stream,
      size,
      fileName: fileRecord.file_name,
      mimeType: fileRecord.mime_type || 'application/octet-stream',
      remoteParentId: destRemoteId,
      virtualPath: fileRecord.virtual_path,
    });
  }

  async moveFile(fileRecord, destRemoteId) {
    const newFile = await this.copyFile(fileRecord, destRemoteId);
    try { await this.deleteFile(fileRecord); } catch (e) { /* best-effort delete */ }
    return newFile;
  }

  async uploadChunked({ chunks, fileName, mimeType, virtualPath, remoteParentId, totalSize }) {
    const collectedChunks = [];
    for await (const chunk of chunks) {
      collectedChunks.push(chunk);
    }

    if (collectedChunks.length === 0) {
      throw new Error('No chunks provided');
    }

    const assembled = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of collectedChunks) {
      const reader = chunk.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assembled.set(value, offset);
        offset += value.byteLength;
      }
    }

    return this.uploadStream({
      stream: new Response(assembled).body,
      size: totalSize,
      fileName,
      mimeType,
      virtualPath,
      remoteParentId,
    });
  }
}
