# Сборка

Используйте Node.js 22.12 или новее. В корне проекта выполните:

```sh
npm ci
npm test
npm run lint
```

Запустите приложение командой `npm start`. Скрипты настройки пакетов:

```sh
npm run dist:win       # Windows x64 EXE
npm run dist:linux     # Linux x64 AppImage
npm run dist:mac:arm64 # macOS arm64 DMG
```

Файлы сборки записываются в `release/`. Сборка Debian отключена, пока не заданы публичный адрес проекта и email сопровождающего. Подпись и нотариальное заверение для macOS и Windows не настроены. Проверка лицензий и уведомлений для включённых sing-box/Cronet ещё не завершена; до этого пакеты распространять нельзя.
