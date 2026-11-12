# SFTP file manager

The file manager uses SFTP over the active SSH connection. It can list directories, create files and folders, preview regular text files up to 256 KB, delete a selected remote item after confirmation, and upload local files or folders.

## Uploads

Select **Upload files** to open the operating system's file picker. The renderer cannot submit an arbitrary local path. Symbolic links in local folders are skipped with an error, and uploads that would follow a remote symbolic link are refused. The app checks the top-level destination and asks before replacing it; when replacing a directory, matching nested files may be overwritten as part of that confirmed operation.

The current UI does not download remote files to the local machine. Large remote files are not previewed. Remote permissions and SFTP server capabilities can limit operations.
