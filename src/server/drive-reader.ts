export async function listAllFiles(drive: any, folderId: string, pathPrefix = '') {
  let files: any[] = [];
  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime)',
    });
    for (const file of response.data.files || []) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        files = files.concat(await listAllFiles(drive, file.id, `${pathPrefix}${file.name}/`));
      } else {
        files.push({ ...file, path: `${pathPrefix}${file.name}` });
      }
    }
  } catch (error: any) {
    console.warn(`Drive files listing notice in folder ${folderId}:`, error?.message || error);
  }
  return files;
}

export async function getFileContent(drive: any, fileId: string, mimeType: string, timeoutMs = 12000) {
  try {
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout reading file')), timeoutMs));
    const downloadPromise = (async () => {
      if (mimeType.includes('google-apps.document')) {
        const response = await drive.files.export({ fileId, mimeType: 'text/plain' });
        return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      }
      if (mimeType.includes('google-apps.spreadsheet')) {
        const response = await drive.files.export({ fileId, mimeType: 'text/csv' });
        return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      }
      if (mimeType.includes('google-apps.presentation')) {
        const response = await drive.files.export({ fileId, mimeType: 'text/plain' });
        return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      }
      const response = await drive.files.get({ fileId, alt: 'media' });
      if (typeof response.data === 'string') return response.data;
      if (Buffer.isBuffer(response.data)) return response.data.toString('utf-8');
      return typeof response.data === 'object' ? JSON.stringify(response.data) : String(response.data);
    })();
    return await Promise.race([downloadPromise, timeoutPromise]) as string | null;
  } catch (error: any) {
    console.warn(`Drive file reading notice ${fileId}:`, error?.message || error);
    return null;
  }
}
