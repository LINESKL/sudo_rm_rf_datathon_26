# Навигация по источникам GuardTusk

- Продукт, минимальный сценарий UI, референс Forte, цвета и ограничения: [бриф frontend](../frontend/BRIEF.md).
- Требования PDF, отличие обязательного от расширений и порядок задач Linear: [разбор кейса](../frontend/case-analysis.md). Пользователь разрешил продолжить разработку с F0/F1.
- Выполненные проверки F0/F1/F2 и открытая приёмка F6: [отчёт приёмки](../frontend/acceptance.md).
- Система и API: [спецификация](../superpowers/specs/2026-10-17-cashguard-design.md), разделы 5–6; действующая схема — `backend/app/schemas.py`, проекции ML — `ml/types.py`, примеры демо — `docs/frontend/mock_details*.json`.
- Интеграция, nullable-нормативы и защищённый media-доступ: [контракт](../frontend/backend-integration.md). Настройки сервера — `backend/app/config.py`, `.env.example`; подключение ML — `ml/README.md`, `requirements-ml.txt`; запуск — `deploy/README.md`.
- Запуск, демо и границы готовности: корневой [README](../../README.md).
- Runtime и quality commands: `frontend/package.json`, `frontend/package-lock.json`, `frontend/vite.config.ts`, `frontend/tsconfig.json`, `frontend/eslint.config.js`.
- Общие UI-компоненты shadcn/ui: `frontend/src/components/ui/`; конфигурация CLI и aliases: `frontend/components.json`; Tailwind-плагин и alias `@/`: `frontend/vite.config.ts`, `frontend/tsconfig.json`.
- Сценарий загрузки и polling: `frontend/src/App.tsx`, `frontend/src/useAnalysis.ts`, `frontend/src/api/client.ts`; карточки результата и lightbox — `frontend/src/components/ResultView.tsx`.
- Каноническая светлая тема shadcn/ui и стили Forte: `frontend/src/styles.css`; локальный Open Sans и лицензия: `frontend/src/assets/fonts/`; JetBrains Mono: импорт в `frontend/src/main.tsx`; HTTP-заглушка для разработки: `frontend/dev/demo-api.ts`.

Root AGENTS применяется ко всем областям. Отдельные scopes добавляйте только при появлении специфичных правил.
