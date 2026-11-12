; 3RTC per-user installer (Inno Setup 6). No admin rights: installs to
; %LOCALAPPDATA%\Programs\3RTC, a Start menu shortcut, and an uninstaller in Settings > Apps.
; Built by package.ps1: iscc /DAppBuild=261112.1430 /DSourceExe=...\3rtc.exe /O<out> 3rtc.iss
; The app updates itself in place in that folder (crates/app/src/update.rs); this installer is
; for the first install, and a newer one can be run over an older install at any time.

#ifndef AppBuild
  #define AppBuild "0.0"
#endif
#ifndef SourceExe
  #define SourceExe "..\target\release\3rtc.exe"
#endif

[Setup]
AppId={{9E3C1A52-7B44-4C1D-9A6E-3F0B5D2E7A11}
AppName=3RTC
AppVersion={#AppBuild}
AppVerName=3RTC {#AppBuild}
AppPublisher=3RTC
AppPublisherURL=https://3rtc.me
AppSupportURL=https://3rtc.me
DefaultDirName={localappdata}\Programs\3RTC
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=3RTC-Setup-{#AppBuild}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\3rtc.exe
UninstallDisplayName=3RTC
; a running 3RTC is closed for the install (and reopened after it)
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "3rtc.exe"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\3RTC"; Filename: "{app}\3rtc.exe"
Name: "{userdesktop}\3RTC"; Filename: "{app}\3rtc.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\3rtc.exe"; Description: "Open 3RTC"; Flags: nowait postinstall skipifsilent

[Registry]
; what the app writes for itself (3rtc:// links, Start with Windows) goes with it
Root: HKCU; Subkey: "Software\Classes\3rtc"; Flags: uninsdeletekey dontcreatekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "3RTC"; Flags: uninsdeletevalue dontcreatekey

[UninstallDelete]
; left behind by an update in place
Type: files; Name: "{app}\3rtc.old.exe"
Type: files; Name: "{app}\3rtc.new.exe"
