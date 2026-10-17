# 03. Детекция, трекинг и извлечение событий (кассовая комната, оверхед-камера)

Дата: 2026-10-17. Статус: ресёрч для хакатона (~24 ч). Только open-source с лицензией, допускающей коммерческое использование. Распознавание лиц запрещено, везде используем роль по положению и поведению.

Маркировка достоверности чисел:
- **[V]** проверено по первоисточнику (README/модель-кард) при подготовке документа;
- **[M]** значение из статьи/model card, известное по памяти, ссылка в списке источников, перед публикацией перепроверить;
- **[E]** моя инженерная оценка, не измерение. Перед выбором железа прогнать бенчмарк на 20 реальных кадрах (раздел 8).

---

## 0. TL;DR

1. **Запретные лицензии (красные флаги):** Ultralytics YOLOv8/11/12 и всё, что на них построено (**YOLOE**, YOLOv8-World в Ultralytics), **BoxMOT** и встроенные трекеры Ultralytics: **AGPL-3.0**. **YOLO-World** (Tencent AILab): **GPL-3.0**, авторы заявляют "supported for commercial usage", но копилефт никуда не делся, для коммерческой лицензии они просят писать на почту. **Grounding DINO 1.5/1.6**: в репозитории только API (веса не опубликованы, лицензия на веса не найдена), как локальный сервис недоступен.
2. **Чистые (Apache-2.0/MIT) варианты:** Grounding DINO 1.0 (Apache-2.0), OWL-ViT/OWLv2 (Apache-2.0), Florence-2 (MIT), RT-DETR/RT-DETRv2/D-FINE/DEIM/RF-DETR N–L (Apache-2.0), YOLOX (Apache-2.0), SAM 2/2.1 (Apache-2.0), SigLIP 2 (Apache-2.0), RTMPose/MMPose (Apache-2.0), ViTPose (Apache-2.0), ByteTrack/OC-SORT/BoT-SORT (MIT), `supervision` (MIT), `roboflow/trackers` (Apache-2.0).
3. **Рекомендуемый стек:** базовый COCO-детектор **D-FINE-M/L (или RF-DETR-M)** для person/phone/cup/handbag/laptop/chair/table + **OWLv2** (текст и image-guided запросы) для нестандартных классов (пачка купюр, зелёная сумка, сейф, ключ, дверь) + **SigLIP 2** (zero-shot + линейный зонд на 20–50 кропах) для состояний (экран, сейф, дверь) + **ByteTrack** (supervision) для треков + геометрия относительно "якорей" сцены (стол/ноутбук/стул) для ролей и "человек за спиной кассира" + гистерезис/мин. длительность для событий.
4. **Частота:** базовая 5 fps, 15 fps (а при желании 30) только в окнах вокруг кандидатов для уточнения таймкодов. Видео короткие (≤145 с, максимум ~725 кадров при 5 fps), поэтому даже тяжёлые модели на 24 GB GPU укладываются в минуты, а на CPU надо ограничивать тяжёлые модели ключевыми кадрами.
5. **Главные риски:** малый размер телефона/купюр/ключа на 464x848 в оверхеде (решается кропами и апсемплингом вокруг рук/стола), экран ноутбука (несколько десятков пикселей: lock vs unlocked надёжно различимы только по яркости/цвету/смене состояния), COCO-детекторы хуже работают на видах сверху (нужен мини-файнтюн по псевдоразметке).

---

## 1. Лицензии: сводка с красными флагами

| Компонент | Лицензия кода | Лицензия весов / особенности | Коммерция? | Источник |
|---|---|---|---|---|
| Ultralytics YOLOv8/11/12 | **AGPL-3.0** | веса под ней же | **НЕТ без платной Enterprise-лицензии** (сетевое использование триггерит AGPL) | [Ultralytics licensing](https://www.ultralytics.com/license) |
| **YOLOE** (THU-MIG) | **AGPL-3.0** [V] | построен на Ultralytics; для текстовых промптов нужен MobileCLIP (веса Apple, условия отдельные, проверить) | **НЕТ** | [github.com/THU-MIG/yoloe](https://github.com/THU-MIG/yoloe) |
| **YOLO-World** (AILab-CVC) | **GPL-3.0** [V] | README: "supported for commercial usage", иначе писать авторам; Ultralytics-порт YOLOv8-World уже AGPL | **Риск**: копилефт, при поставке заказчику бинарника нужно отдавать исходники. Для чистой коммерции брать только по отдельной лицензии | [github.com/AILab-CVC/YOLO-World](https://github.com/AILab-CVC/YOLO-World) |
| Grounding DINO 1.0 | Apache-2.0 [V] | HF `IDEA-Research/grounding-dino-tiny`, `-base` (Apache-2.0 [M]) | Да | [github.com/IDEA-Research/GroundingDINO](https://github.com/IDEA-Research/GroundingDINO) |
| **Grounding DINO 1.5 / 1.6 (Edge, Pro)** | отдельный репозиторий `Grounding-DINO-1.5-API` | **только API на DeepDataSpace**, веса и лицензия на них в проверенных источниках не найдены [V/неполно] | **Не использовать для локального сервиса** | [GroundingDINO-1.5-API](https://github.com/idea-research/grounding-dino-1.5-api), [arXiv 2405.10300](https://arxiv.org/abs/2405.10300) |
| OWL-ViT / OWLv2 | Apache-2.0 [M] | HF `google/owlvit-base-patch32`, `google/owlv2-base-patch16-ensemble`, `google/owlv2-large-patch14-ensemble` | Да | [HF docs OWLv2](https://huggingface.co/docs/transformers/model_doc/owlv2) |
| Florence-2 | **MIT** [V] | HF `microsoft/Florence-2-base`, `-large`, `-ft` | Да | [HF Florence-2-large-ft](https://huggingface.co/microsoft/Florence-2-large-ft) |
| RT-DETR / RT-DETRv2 | Apache-2.0 [M] | HF `PekingU/rtdetr_r50vd_coco_o365`, `PekingU/rtdetr_v2_r18vd`... | Да (оговорка про Objects365 ниже) | [HF RT-DETR](https://huggingface.co/docs/transformers/model_doc/rt_detr) |
| D-FINE | Apache-2.0 [V] | чекпоинты `*_obj365`/`*_obj2coco` "may be subject to Objects365 terms" [V] | Да; для безопасности брать `*_coco` | [github.com/Peterande/D-FINE](https://github.com/Peterande/D-FINE) |
| DEIM / DEIMv2 | Apache-2.0 (по бейджу) [V] | DEIMv2 S/M/L/X используют признаки **DINOv3** (у DINOv3 своя лицензия, проверить до использования) | Да, DEIM v1 безопаснее | [github.com/Intellindust-AI-Lab/DEIM](https://github.com/Intellindust-AI-Lab/DEIM) |
| RF-DETR | Apache-2.0 для Nano/Small/Medium/Large (det) и всех seg [V] | **PML 1.0** (платная/ограниченная) для Atto/Femto/Pico/XL/2XL и `rfdetr_plus` [V] | Да только для N–L | [github.com/roboflow/rf-detr](https://github.com/roboflow/rf-detr) |
| YOLOX | Apache-2.0 [V] | старая архитектура | Да | [github.com/Megvii-BaseDetection/YOLOX](https://github.com/Megvii-BaseDetection/YOLOX) |
| SAM 2 / 2.1 | Apache-2.0 [V] | чекпоинты тоже Apache-2.0 [V] | Да | [github.com/facebookresearch/sam2](https://github.com/facebookresearch/sam2) |
| SAM 3 | **"SAM License"** (кастомная) [V] | гейтед-доступ на HF (нужен запрос). Условия коммерции читать в LICENSE | **Проверить юристом**, на хакатоне не брать в основу | [github.com/facebookresearch/sam3](https://github.com/facebookresearch/sam3) |
| CLIP (OpenAI) / OpenCLIP | MIT [M] | веса OpenAI под MIT; веса LAION в OpenCLIP по картам | Да | [openai/CLIP](https://github.com/openai/CLIP) |
| SigLIP 2 | Apache-2.0 (по листингам зеркал; официальную карту не открыл) [неполно] | HF `google/siglip2-base-patch16-224`, `google/siglip2-so400m-patch14-384` | Да (перепроверить на карточке google/...) | [HF SigLIP2 mirrors/FiftyOne](https://docs.voxel51.com/model_zoo/models/google_siglip2_base_patch16_224.html) |
| RTMPose / MMPose / RTMDet | Apache-2.0 [V] | веса обучены на датасетах со своими условиями (Halpe, AIC, COCO-WholeBody...) | Да, но проверить датасеты | [github.com/open-mmlab/mmpose](https://github.com/open-mmlab/mmpose) |
| ViTPose | Apache-2.0 [M] | HF `usyd-community/vitpose-base-simple`, `vitpose-plus-*` | Да | [HF ViTPose](https://huggingface.co/docs/transformers/model_doc/vitpose) |
| 100DOH hand_object_detector | **MIT** код [V] | данные 100DOH/эго-датасеты имеют свои условия (Epic-Kitchens, EGTEA, CharadesEgo) [V] | Код да, веса/датасеты проверить | [github.com/ddshan/hand_object_detector](https://github.com/ddshan/hand_object_detector) |
| ByteTrack | MIT [M] | - | Да | [ifzhang/ByteTrack](https://github.com/ifzhang/ByteTrack) |
| BoT-SORT | MIT [M] | - | Да | [NirAharon/BoT-SORT](https://github.com/NirAharon/BoT-SORT) |
| OC-SORT | MIT [M] | - | Да | [noahcao/OC_SORT](https://github.com/noahcao/OC_SORT) |
| `supervision` | MIT [M] | содержит `sv.ByteTrack`, `sv.PolygonZone`, `sv.LineZone` | Да | [roboflow/supervision](https://github.com/roboflow/supervision) |
| `roboflow/trackers` | Apache-2.0 [V] | SORT, ByteTrack, OC-SORT, BoT-SORT (с компенсацией движения камеры) [V] | Да | [github.com/roboflow/trackers](https://github.com/roboflow/trackers) |
| **BoxMOT** | **AGPL-3.0** [V] | обёртка над ByteTrack/BoT-SORT/OC-SORT/DeepOCSORT... | **НЕТ.** Использовать оригинальные MIT-репозитории или `trackers` | [github.com/mikel-brostrom/boxmot](https://github.com/mikel-brostrom/boxmot) |
| OSNet / torchreid (re-id) | MIT [M] | веса обучены на Market-1501/MSMT17 и т.п., у датасетов исследовательские условия | Код да, веса осторожно | [KaiyangZhou/deep-person-reid](https://github.com/KaiyangZhou/deep-person-reid) |
| DINOv2 (эмбеддинги кропов) | Apache-2.0 [M] | альтернатива re-id без датасетов с лицами | Да | [facebookresearch/dinov2](https://github.com/facebookresearch/dinov2) |

Практические правила:
- Нигде в коде не импортировать `ultralytics`, `boxmot`, `yoloe`, `yolo_world` (последний только после решения по GPL).
- Для псевдоразметки (авто-лейблинг для файнтюна) использовать только Apache/MIT модели (OWLv2, Grounding DINO 1.0, Florence-2), чтобы не тащить копилефт-происхождение в обученные веса.
- В обучении D-FINE брать `*_coco` чекпоинты, а не `*_obj365`, если нужна максимально чистая цепочка.
- Это инженерная справка, а не юридическая консультация: перед продом показать список юристу.

---

## 2. Сравнительная таблица детекторов

Скорости: **[V]** = официальные T4 TensorRT FP16 batch 1 (не 4090!). Для 4090 дана **оценка [E] ~2–3x к T4** (одно поколение/класс выше, FP16 TRT), для CPU **оценка [E]** для ONNX Runtime 8–16 потоков. Всё надо измерить (раздел 8).

### 2.1 Закрытый словарь (быстрые, основа для person/phone/cup/handbag/laptop)

| Модель | Лицензия | COCO AP | Скорость T4 [V] | 4090 [E] | CPU [E] | Малые объекты (телефон) | HF / pip |
|---|---|---|---|---|---|---|---|
| D-FINE-N | Apache | 42.8 | 2.12 мс (~470 fps) | >600 fps | 25–40 fps | слабо | `DFineForObjectDetection`, `ustc-community/dfine-*` |
| D-FINE-S | Apache | 48.5 | 3.49 мс (~290 fps) | >500 fps | 12–20 fps | средне | то же |
| **D-FINE-M** | Apache | 52.3 | 5.62 мс (~180 fps) | ~400 fps | 5–9 fps | хорошо | то же |
| **D-FINE-L** | Apache | 54.0 | 8.07 мс (~124 fps) | ~300 fps | 2–4 fps | хорошо | то же |
| D-FINE-X | Apache | 55.8 | 12.89 мс (~78 fps) | ~200 fps | 1–2 fps | лучше всех из семьи | то же |
| DEIM-D-FINE-L / X | Apache | 54.7 / 56.5 | 8.07 / 12.89 мс | как D-FINE | как D-FINE | чуть лучше D-FINE | нет в `transformers` (репо, конфиги D-FINE) |
| RT-DETRv2-S/M/L | Apache | ~48–53 | 4.6 / 6.4 / 9.2 мс (DEIM-таблица) [V] | ~2-3x быстрее | 3–8 fps | средне | `RTDetrV2ForObjectDetection` |
| RT-DETR (v1) r50vd | Apache | 53.1 [M] | ~108 fps T4 [M] | | | | `PekingU/rtdetr_r50vd_coco_o365` |
| **RF-DETR Nano/Small/Medium/Large** | Apache (N–L) | 48.4 / 53.0 / 54.7 / 56.5 | 2.3 / 3.5 / 4.4 / 6.8 мс [V] | ~2-3x быстрее | M: 3–6 fps | хорошо (DINOv2-бэкбон) | `pip install rfdetr`, `RFDETRMedium` |
| RF-DETR XL / 2XL | **PML 1.0** | 58.6 / 60.1 | 11.5 / 17.2 мс | | | | `rfdetr[plus]`, **не использовать** |
| YOLOX-s/m/l/x | Apache | 40.5 / 46.9 / 49.7 / 51.1 | V100: 9.8 / 12.3 / 14.5 / 17.3 мс [V] | | s: 8–15 fps | слабее D-FINE | нет в HF (репо, ONNX) |
| YOLOv8/11/12 | **AGPL** | высокие | | | | | **не использовать** |

Выводы:
- Оба лидера (D-FINE и RF-DETR) по качеству/скорости обходят YOLOX и RT-DETRv2. RF-DETR требует `pip install rfdetr`, D-FINE даёт чистый путь через `transformers` (одна зависимость, один код для CPU/MPS/CUDA).
- Отдельных цифр AP_small в источниках не нашёл (README D-FINE и RF-DETR их не приводят) [V]. По статье RT-DETR AP_S для R50 порядка 35 при общем AP 53 [M]: малые объекты примерно на 40% хуже. Вывод для телефона на 464x848 сверху: ожидать провалы без кропа/апсемплинга.
- COCO-детекторы известны проблемой доменного сдвига на видах сверху (голова/плечи вместо фигуры). Лечится файнтюном на 200–500 кадров (псевдоразметка, раздел 4.6).

### 2.2 Открытый словарь (для нестандартных классов и zero-shot на неизвестный ракурс)

| Модель | Лицензия | Скорость | Качество | Малые объекты | Особенности / код |
|---|---|---|---|---|---|
| **OWLv2** B/16, L/14 | Apache | 960x960 вход (3600 патчей), B/16 ~10–20 fps на 4090 [E], L/14 ~3–6 fps [E]; CPU ~0.5–2 с/кадр [E] | LVIS AP rare 44.6 (L/14 + OWL-ST) [M, статья] | лучший из открытых для мелочи (высокое разрешение, нативно) | `Owlv2ForObjectDetection`, `Owlv2Processor`; text queries + **image-guided** (`image_guided_detection`, запрос эталонным кропом, удобно для "пачка купюр"/"зелёная сумка") |
| OWL-ViT B/32 | Apache | быстрее, ~30–60 fps GPU [E] | хуже v2 | слабо (768 вход, B/32) | `OwlViTForObjectDetection` |
| **Grounding DINO 1.0** tiny/base | Apache | tiny ~10–15 fps, base ~5–8 fps на 4090 [E]; CPU 2–5 с/кадр [E] | COCO zero-shot 48.4–52.5 AP [V] | средне/слабо; хорошо с фразами ("cell phone in hand") | `GroundingDinoForObjectDetection`, `IDEA-Research/grounding-dino-tiny|base`; пороги box/text обязательны. `mm-grounding-dino` (MMDetection, Apache) обучен на больших данных, но требует mmcv |
| Grounding DINO 1.5 / 1.6 | только API | Edge: ~75 fps на Orin NX с TRT (статья) [M] | сильнее 1.0 | | **не подходит**, веса не опубликованы |
| **Florence-2** base 0.23B / large 0.77B | **MIT** | base ~10–20 fps / large ~4–8 fps на 4090 [E], CPU large 1–3 с [E] | OD `<OD>`, `<CAPTION_TO_PHRASE_GROUNDING>`, `<OPEN_VOCABULARY_DETECTION>`, `<DENSE_REGION_CAPTION>`, VQA-подобные [M, model card] | слабо на мелочи (768x768 вход), метки без score | `AutoModelForCausalLM.from_pretrained(..., trust_remote_code=True)`; на новых `transformers` (>=4.50) `generate` у remote-code версии может ломаться (предупреждение в OpenVINO-ноутбуке) [V], смотреть нативный порт в свежей версии |
| YOLO-World | **GPL-3.0** | S/M/L/X, оригинал 52 FPS на V100 для L (статья) [M] | LVIS AP: S 18.5, M 24.1, L 26.8, X 28.6 [V] | средне | **лицензия блокирует**; можно использовать как офлайн-учителя только после решения по GPL |
| YOLOE | **AGPL-3.0** | v8-S/L: 306/102 fps (текст) на T4 TRT [V] | сильное | средне | **блокирует лицензия** |
| SAM 3 | SAM License, gated | | концепт-сегментация по тексту | | юридически проверить; на хакатоне пропустить |

Выводы:
- **OWLv2** главный открытый словарь для задачи: мелкие объекты, image-guided запросы (по 1 эталонному кропу пачки/сумки/ключа), Apache.
- **Grounding DINO 1.0**: хорош на "фразовых" запросах (person with green bag), использовать как второй голос/псевдо-разметчик.
- **Florence-2** как проверяющий второй голос на ключевых кадрах: caption-to-phrase-grounding ("the person standing behind the seated woman") MIT-лицензия, но детали теряет.
- GDINO-1.5/YOLO-World/YOLOE не использовать в рекомендованном стеке.

### 2.3 Сегментация и трекинг по маске

| Модель | Лицензия | Скорость | Роль |
|---|---|---|---|
| **SAM 2.1** tiny/small/base+/large | Apache | A100, видео: 91 / 85 / 64 / 39.5 fps [V]. 4090 [E] ~0.6–0.8 от A100. CPU непригоден (<1 fps) [E] | Разделение слипшихся людей (кассир + человек за спиной), маска стола/сейфа/двери по box-промпту, удержание ID при перекрытии. HF: чекпоинты `facebook/sam2.1-hiera-*`; pip: установка из репо (`pip install -e .`) PyPI-релиза в README нет [V]; в свежем `transformers` есть `Sam2Model` [M, проверить] |
| SAM 3 | SAM License | | отложить |

SAM2 не нужен на каждый кадр: вызывать по запросу (бокс-промпт из D-FINE) для спорных кластеров людей и для масок якорей (стол, сейф).

### 2.4 Классификация кропов (состояния)

| Модель | Лицензия | Скорость | Идея |
|---|---|---|---|
| **SigLIP 2** B/16 (86M визуальный), so400m | Apache (зеркала) | B/16 224px ~500+ кропов/с на 4090 [E], CPU ~10–30 кропов/с [E] | Zero-shot по промптам + **линейный зонд на 20–50 размеченных кропах** (логрегрессия на эмбеддингах) |
| CLIP ViT-B/32, B/16 | MIT | как выше | fallback, слабее на тонких различиях |

Код: `AutoModel`/`AutoProcessor` из `transformers`, `pipeline("zero-shot-image-classification", model="google/siglip2-base-patch16-224")`. У SigLIP-семейства используется сигмоидный скор: не применять softmax между разнородными промптами без калибровки; для бинарного состояния сравнивать пару логитов ("lit" vs "dark") и усреднять по нескольким формулировкам.

### 2.5 Поза и рука-объект

| Модель | Лицензия | Скорость | Оценка |
|---|---|---|---|
| **RTMPose-m** (+ RTMDet-nano/RTMW) | Apache | 75.8 AP COCO, 90+ fps на CPU i7-11700, 430+ fps GTX 1660Ti [V]. RTMW-l 70.1 mAP COCO-WholeBody [V]. Hand-модели: RTMDet-nano hand det 76.0 AP OneHand10K, RTMPose-m hand 81.5 PCK@0.2 (alpha) [V] | Лучший баланс скорости и качества, в т.ч. на CPU. `pip install rtmlib` (ONNX, без mmcv) [M] или `mmpose` |
| **ViTPose** base/large/huge, ViTPose++ | Apache | точнее RTMPose, тяжелее (ViT) | `VitPoseForPoseEstimation`, `usyd-community/vitpose-base-simple`, `vitpose-plus-*` [V]; top-down: нужен детектор человека, боксы в формате COCO xywh [V] |
| MediaPipe Hands | Apache [M] | CPU-friendly | на 20-пиксельных руках из оверхеда ломается, не основа |
| **100DOH hand_object_detector** | MIT код | Faster R-CNN R101, PyTorch 1.0, сборка CUDA-расширений, **нет Mac** | Выдаёт для руки состояние контакта N/S/O/P/F (нет/сам/другой человек/переносимый объект/мебель) + offset-вектор к объекту [V]. Отлично по смыслу ("рука держит переносимый предмет"), но обучено на третьем лице/эго, оверхед вне домена, окружение устарело. **Использовать как опцию, не основу** |

Практика: для "телефон в руке" достаточно **геометрической эвристики**: `phone` bbox пересекает область запястья/кисти (кропы из RTMPose wrist keypoints) или лежит в радиусе r от запястья, и телефон движется вместе с запястьем. Эвристика дешёвая, её порог калибруется нормировкой на размер человека.

### 2.6 Трекеры

| Трекер | Лицензия | Подходит | Заметки |
|---|---|---|---|
| **ByteTrack** | MIT | да, основной | Без appearance, использует низко-скоринговые детекции; `sv.ByteTrack` из supervision или `trackers.ByteTrackTracker` |
| **OC-SORT** | MIT | да, при перекрытиях | Observation-centric, лучше при нелинейном движении и пропажах |
| BoT-SORT | MIT | избыточен | Компенсация движения камеры (камера статична) + ReID-эмбеддинги; в `trackers` есть [V] |
| DeepOCSORT/StrongSORT/BoostTrack | через BoxMOT = **AGPL** | **нет** | Брать оригинальные репо при необходимости |
| Встроенные в Ultralytics | AGPL | нет | |

Реализация: `pip install supervision trackers`. ID-свичи в оверхеде при перекрытии неизбежны: сшивать треки по близости/времени и эмбеддингу (раздел 5).

### 2.7 Re-ID без лиц

- Простейший вариант для клипа: **цвет/текстура одежды + положение + время**; hist в HSV по верхней части кропа плюс DINOv2-ViT-S эмбеддинг кропа тела (не лица): сшивка трекайлетов внутри одного клипа.
- OSNet (`torchreid`, MIT) работает, но веса получены на Market-1501/MSMT17 (исследовательские условия) и оверхед для них вне домена.
- Юридически: эмбеддинг всего тела может считаться биометрическим идентификатором в ряде юрисдикций. Хранить эмбеддинги только в оперативной памяти в рамках клипа, не сохранять между клипами и не сопоставлять с базами. В отчёте указывать "person_track_N", а не личность.

---

## 3. Что чем детектируем (сигнал → модель)

| Сигнал | Основной метод | Резерв / проверка | Частота | Нюанс |
|---|---|---|---|---|
| Люди (боксы, треки) | D-FINE-M / RF-DETR-M `person` + ByteTrack | OWLv2 "person" на 1 fps как кросс-проверка; SAM2 для слипшихся | 5 fps | Дообучить на оверхед-кадрах |
| Роль: кассир / клиент / инкассатор | Геометрия + поведение (раздел 4) | SigLIP2-кроп "person carrying green bag / uniform" как слабый признак | трек-уровень | Не лицо |
| Телефон в руке | COCO `cell phone` на кропах вокруг рук + эвристика близости к запястью | OWLv2 "a mobile phone"; RTMPose wrist | 5 fps, 15 fps в окнах | Кроп x3 апсемплинг (SAHI-слайсинг), MIT/Apache библиотека `sahi` [M] |
| Чашки/еда/напитки | COCO `cup`, `bottle`, `wine glass`, `bowl`, `banana/apple/sandwich/cake...` | OWLv2 "paper coffee cup", "food on a plate" | 2 fps | Статичные предметы; агрегировать по окнам |
| Сумки/верхняя одежда на столе | COCO `handbag`, `backpack`, `suitcase` внутри маски стола | OWLv2 "a jacket", "a coat on the desk" | 2 fps | "на столе" = центр бокса в полигоне/маске стола |
| Пачки купюр | OWLv2 image-guided (эталонный кроп пачки) + текст "bundle of banknotes" | Grounding DINO фраза; SigLIP2 на кропах кандидатов | 5 fps | Малые, плоские, часто в руках |
| Зелёная инкассаторская сумка | OWLv2 "green bag" + HSV-фильтр (доля зелёных пикселей в боксе) | SigLIP2 | 5 fps | Цвет дешёвый и угол-независимый |
| Экран ноутбука: яркий/разблокирован/блокировка/тёмный | кроп верхней крышки ноутбука -> SigLIP2 (линейный зонд) + статистика яркости (средний V, доля насыщенных, энтропия) | zero-shot промпты | 1–2 fps | Различие lock vs app по мелкому кропу ненадёжно, использовать смену состояния и текстурность |
| Сейф открыт/закрыт | детект сейфа (OWLv2 "small metal safe") -> кроп -> SigLIP2 линейный зонд + сравнение с эталоном "закрыт" (площадь тёмной полости, SSIM) | image-guided OWLv2 "open safe door" | 2 fps | Дверца видна сверху как смещённый прямоугольник |
| Ключ в замке сейфа | кроп зоны замка (верхний апсемплинг x4) -> OWLv2 image-guided "key" / SigLIP2 | Florence-2 `<OPEN_VOCABULARY_DETECTION>` | 2 fps, 15 в окнах | Самый шумный сигнал, подавать как "вероятно" |
| Дверь открыта/закрыта | детект двери ("glass door") -> зона двери; состояние: SigLIP2 на кропе + изменение (разностный кадр) в зоне | косвенно: рождение/гибель треков у двери | 2 fps | Стекло, блики |
| Вход/выход из комнаты | трек пересекает линию/зону двери (`sv.LineZone`/`PolygonZone`) + рождение/смерть трека в зоне двери | | 5 fps | Нужны время и направление: от двери внутрь или обратно |
| Человек стоит за спиной кассира | относительная геометрия (4.3) | SAM2-маски для проверки | 5 fps | |

---

## 4. Рекомендуемый пайплайн

### 4.1 Общая схема

```
video -> decode (pts-таймкоды) -> sampler (5 fps + burst-окна)
   |
   +-> [A] person/object detector (D-FINE-M | RF-DETR-M)    5 fps, весь кадр + кропы-апсемплы
   +-> [B] open-vocab (OWLv2): якоря сцены (1 раз + ревизия 1/10 с), банкноты, сумки, ключ   2–5 fps
   +-> [C] ByteTrack (persons, bags)                         5 fps
   +-> [D] pose (RTMPose-m) только для person-кропов          5 fps
   +-> [E] state-классификаторы (SigLIP2 crops): экран, сейф, дверь   1–2 fps
   v
frame_signals[t] (булевы/скоры по кадру) -> сглаживание -> гистерезис -> события (start, end, conf)
   v
JSON/CSV событий + аннотированное видео + превью кадров
```

### 4.2 Частоты дискретизации

- **Базовая 5 fps** (события длятся секунды; 145 с => 725 кадров).
- **Медленные состояния** (экран, сейф, дверь, предметы на столе): 1–2 fps достаточно, это сокращает нагрузку на CPU.
- **Burst 15 fps (или нативные 30)**: только в окнах +-1.5 с вокруг кандидатов (смена состояния, пересечение двери) для точных таймкодов start/end.
- Таймкоды брать из PTS кадра (`cv2.CAP_PROP_POS_MSEC` или `ffprobe`/PyAV `frame.pts*time_base`), а не из `i/fps`, если видео с переменной частотой.
- Предобработка: сохранять портрет 464x848 как есть, детектор получает letterbox 640 по длинной стороне (848 -> 640 даёт масштаб 0.75, малые объекты ещё мельче!). Лучше подавать **нативное разрешение (848 по высоте) или апсемпл 1.5x** (D-FINE/RF-DETR принимают произвольные кратные 32 размеры) и делать **тайловую инференцию (SAHI)** для телефона/купюр: 2 тайла 464x464 с перекрытием, масштаб x1.5–2.

### 4.3 Зона кассира, не зависящая от ракурса

Идея: не использовать абсолютные пиксельные координаты. Всё выражать через **якоря сцены** (стол, ноутбук, счётная машинка, стул) и нормировать расстояния на размер самого якоря/человека.

1. **Якоря сцены** (находятся один раз по медиане детекций за первые N секунд, обновляются раз в 10 с):
   - `desk` (COCO `dining table` + OWLv2 "desk"), центр `D`, главная ось по PCA маски/бокса,
   - `laptop` (COCO `laptop`), центр `L`, размер `s_L`,
   - `counter` (OWLv2 "banknote counting machine"), `safe`, `chair` (COCO `chair`).
   - `W` = центроид рабочего места = взвешенное среднее центров {laptop, counter, chair}.
   - `scale` = диагональ бокса стола (используем для всех нормированных расстояний).
2. **Скоринг кассира (по треку, а не по кадру)**:
   ```
   cashier_score(track) =
       0.4 * dwell_near_W        # доля времени, когда |c_p - W| < 0.5*scale
     + 0.25 * hand_on_workplace  # доля времени, когда кисть (RTMPose) внутри бокса laptop/counter/safe(+margin)
     + 0.2 * seated_prior        # пересечение бокса с боксом стула (IoU > 0.3), стоящая/сидящая поза
     + 0.15 * presence_ratio     # длительность видимости трека / длительность клипа
   ```
   Кассир = трек с максимальным score, если score > порога (иначе "кассир не найден", это тоже сигнал). При смене кассира (два высоких трека) считать по окнам.
3. **Клиент**: человек, долго находящийся по другую сторону стола относительно кассира. "Сторона" = знак проекции на нормаль к оси стола: `side(p) = sign((c_p - D) · n)`, где `n` ⟂ главной оси стола, ориентирована в сторону кассира `n = normalize(c_cashier - D)`. Тогда клиент: `side = -1`.
4. **Инкассатор**: трек с привязанной зелёной сумкой (IoU/расстояние бокса сумки до бокса человека < 0.5 его высоты в течение >= 1 с), опционально слабый вклад SigLIP2 "person in uniform". Не кассир и не клиент по умолчанию.
5. **"Человек за спиной кассира"** (инвариантно к ракурсу, нормировка на размер кассира `h_c`):
   ```
   v   = normalize(c_cashier - W)          # от рабочего места к кассиру = "вперёд спиной к столу"
   d   = c_other - c_cashier
   behind = (d · v) > 0.3 * h_c            # дальше от стола, чем кассир
   close  = |d| < 1.5 * h_c                # близко
   lateral = |d - (d·v) v| < 0.8 * h_c     # не сильно сбоку
   ```
   Событие при `behind & close & lateral` непрерывно >= 1.5 с. Для уточнения на случай слияния боксов проверять через SAM2-маски: две отдельные маски в одном кластере.
6. **Валидация**: нарисовать зоны поверх первого кадра и вывести как отладочное изображение. Для неизвестного ракурса сначала смотреть, найдены ли якоря (`laptop`, `desk`); если нет, фолбэк: кассир = самый долго присутствующий трек + положение кистей над предметом "ноутбук/счётная машинка".

### 4.4 Выбор моделей по железу

| Вариант | Детектор | OWLv2 | SigLIP2 | Поза | Трекинг | Комментарий |
|---|---|---|---|---|---|---|
| **GPU 24 GB** | D-FINE-L или RF-DETR-L, FP16 | L/14 960, 2–5 fps | so400m | ViTPose-base/RTMPose-l | ByteTrack | Всё реальное время; SAM2.1 base+ по запросу |
| **Mac M-серии (MPS)** | D-FINE-M (`transformers` на MPS; сконвертировать в ONNX/CoreML при необходимости) | B/16, 0.5–2 fps [E] | base | RTMPose-m (rtmlib, CoreML EP) | ByteTrack | Часть операторов (deformable attention у DETR-семейств, grounding DINO) может падать на MPS: включать `PYTORCH_ENABLE_MPS_FALLBACK=1`; SAM2 на MPS работает медленно [E] |
| **CPU** | D-FINE-S/M в ONNX Runtime, вход 640, 2–4 fps | B/16 только на ключевых кадрах (0.3–1 fps), либо OWL-ViT B/32 | base 224, 1–2 fps | RTMPose-m (ONNX) | ByteTrack | 145 с x 2 fps = 290 кадров; тяжёлые модели раз в секунду |

### 4.5 Что делать для "неизвестного ракурса"

- Опираться на open-vocab и якоря сцены, не на заранее заданные пиксельные ROI.
- Нормированные (на размер якоря/человека) пороги вместо пикселей.
- Все state-классификаторы работают на **кропах по найденным боксам** (сейф, ноутбук, дверь), а не на фиксированных регионах кадра.
- Простая TTA: поворот/зеркало кропа для SigLIP2 (усреднение), несколько формулировок промптов.
- Калибровка на лету: первые 3–5 с клипа используются для оценки "фонового" вида якорей (экран по умолчанию, сейф закрыт и т.п.), состояния определять как **отклонение от базового** + абсолют.

### 4.6 Мини-файнтюн (если есть 2–4 часа)

1. Вытащить 300–500 кадров (каждые ~1 с из разных клипов).
2. Авторазметка OWLv2 + Grounding DINO 1.0 + COCO D-FINE: слияние по IoU, оставить совпавшие, ручная чистка в CVAT/Label Studio (быстро: только person/phone/bag/banknotes/safe/key).
3. Дообучить **D-FINE-M** (репо Peterande/D-FINE, конфиги COCO, 20–30 эпох) или **RF-DETR-M** (`model.train(dataset_dir=..., epochs=...)`), чекпоинт стартует от `*_coco`.
4. Проверка на отложенном клипе другого ракурса, иначе легко переобучиться на один угол.

---

## 5. Из сигналов в события: сглаживание и гистерезис

Принципы:
- Работаем с **трек-уровнем** и **булевыми сигналами по кадру** с непрерывным скором `s ∈ [0,1]`.
- Сглаживание: медиана по окну ~5 сэмплов (1 с при 5 fps) или EMA `alpha=0.4`.
- Гистерезис по двум порогам: включение `s >= T_on`, выключение `s <= T_off` (T_off < T_on), плюс **минимальная длительность** события `min_dur` и **склейка разрывов** `merge_gap`.
- Таймкод начала = время первого кадра подтверждённого состояния (откат на `hold` сэмплов назад), конец = последний кадр до перехода в выключено. При наличии burst-режима уточнять в окне 15 fps бинарным поиском изменения скора.

Типовые параметры (стартовые, подбирать по клипам):

| Событие | T_on / T_off | min_dur | merge_gap |
|---|---|---|---|
| Телефон в руке | 0.5 / 0.3 | 1.0 с | 1.0 с |
| Человек за спиной кассира | 0.6 / 0.4 | 1.5 с | 1.5 с |
| Сейф открыт | 0.6 / 0.4 | 1.0 с | 2.0 с |
| Экран: lit/unlocked | 0.6 / 0.4 | 1.0 с | 2.0 с |
| Вход/выход | пересечение линии, без гистерезиса | - | дебаунс 1 с на трек |

### Псевдокод

```python
from dataclasses import dataclass
from collections import deque

@dataclass
class Event:
    kind: str        # "phone_in_hand", "behind_cashier", "safe_open", ...
    track_id: int | None
    t_start: float   # секунды от начала клипа (по PTS)
    t_end: float
    conf: float

def smooth(xs, k=5):                       # скользящая медиана
    out, buf = [], deque(maxlen=k)
    for x in xs:
        buf.append(x); out.append(sorted(buf)[len(buf)//2])
    return out

def hysteresis_events(ts, scores, kind, track_id,
                      t_on, t_off, min_dur, merge_gap):
    """ts: таймкоды (с), scores: сглаженные [0..1]. Возвращает список Event."""
    events, active, start, peak = [], False, None, 0.0
    for t, s in zip(ts, scores):
        if not active and s >= t_on:
            active, start, peak = True, t, s
        elif active:
            peak = max(peak, s)
            if s <= t_off:
                events.append(Event(kind, track_id, start, t, peak))
                active = False
    if active:                                   # событие дошло до конца клипа
        events.append(Event(kind, track_id, start, ts[-1], peak))
    # склейка близких событий и отсев коротких
    merged = []
    for e in events:
        if merged and e.t_start - merged[-1].t_end <= merge_gap:
            merged[-1].t_end = e.t_end
            merged[-1].conf = max(merged[-1].conf, e.conf)
        else:
            merged.append(e)
    return [e for e in merged if e.t_end - e.t_start >= min_dur]

def per_frame_signals(frame, state):
    dets   = detector(frame)                       # D-FINE/RF-DETR: person, phone, cup, bag, laptop...
    tracks = tracker.update(dets.persons)          # ByteTrack
    anchors = state.anchors.update(frame, dets)    # desk, laptop, safe, door, W, scale (медиана/редкий OWLv2)
    roles  = state.roles.update(tracks, anchors)   # cashier_score по окну, client/encashment
    poses  = pose(frame, tracks.boxes)             # RTMPose, нужны запястья
    sig = {}
    for tr in tracks:
        sig[("phone_in_hand", tr.id)] = phone_near_wrist(dets.phones, poses[tr.id], tr.h)
    cashier = roles.cashier
    for tr in tracks:
        if cashier and tr.id != cashier.id:
            sig[("behind_cashier", tr.id)] = behind_score(tr, cashier, anchors)  # плавный скор из d·v, |d|, lateral
    sig["safe_open"]   = state.safe_cls(crop(frame, anchors.safe))      # SigLIP2 зонд, p(open)
    sig["screen_lit"]  = state.screen_cls(crop(frame, anchors.screen))  # p(lit_unlocked)
    sig["door_open"]   = state.door_cls(crop(frame, anchors.door))
    return sig, tracks

def extract_events(video):
    frames = sample(video, fps=5)                 # (t, frame) по PTS
    series = defaultdict(list); ts = []
    for t, f in frames:
        sig, tracks = per_frame_signals(f, state)
        ts.append(t)
        for k, v in sig.items():
            series[k].append(v)
        door_crossings(tracks, anchors.door_line, t, out=entries_exits)  # sv.LineZone, направление

    events = list(entries_exits)
    for key, xs in series.items():
        kind, tid = key if isinstance(key, tuple) else (key, None)
        p = PARAMS[kind]                           # T_on, T_off, min_dur, merge_gap
        events += hysteresis_events(ts, smooth(xs), kind, tid, **p)

    events = refine_boundaries(events, video)      # перепрогон окон +-1.5 с на 15 fps, уточнить t_start/t_end
    return sorted(events, key=lambda e: e.t_start)
```

Замечания:
- `behind_score` сделать непрерывным (например, произведение трёх сигмоид по `d·v`, `|d|`, `lateral`), иначе гистерезис бессмысленен.
- Для состояния `screen` лучше событийно: "экран потух", "экран зажёгся", "экран сменился" через производную от скора, а не абсолют.
- Каждое событие хранить с `conf` и ссылкой на кадр-доказательство (путь к jpg) для аудита.
- ID-свичи: перед агрегацией по `track_id` склеить треки, если конец одного и начало другого различаются < 1 с, расстояние < 0.5 `h` и близки по цвету одежды (HSV-hist).

---

## 6. Нюансы кода (transformers и пр.)

- **D-FINE**: `from transformers import DFineForObjectDetection, AutoImageProcessor`; чекпоинты организации `ustc-community` (`dfine-small-coco`, `dfine-xlarge-coco`, `*_obj2coco`) [V]. `post_process_object_detection(outputs, target_sizes=..., threshold=0.3)`. Нет NMS: используется top-k.
- **RT-DETR(v2)**: `RTDetrForObjectDetection` / `RTDetrV2ForObjectDetection`; пример с `PekingU/rtdetr_r50vd_coco_o365` приведён в документации ViTPose как детектор людей [V].
- **OWLv2**: `Owlv2Processor`, `Owlv2ForObjectDetection`; вход 960x960 (паддинг до квадрата! вертикальный кадр 464x848 будет сильно паддиться: учитывать при пересчёте координат, использовать `post_process_object_detection(..., target_sizes=max-side-square)`). Image-guided: `model.image_guided_detection(...)`.
- **Grounding DINO 1.0**: `GroundingDinoForObjectDetection`; текст в нижнем регистре, фразы разделять точкой ("a mobile phone. a green bag."), два порога `box_threshold`, `text_threshold`.
- **Florence-2**: `trust_remote_code=True`; задачи через префиксы `<OD>`, `<CAPTION_TO_PHRASE_GROUNDING>`, `<OPEN_VOCABULARY_DETECTION>`; бокс-скоров нет, поэтому не годится для порогового гистерезиса, только как верификатор.
- **SigLIP 2**: `AutoModel`, `AutoProcessor`; для линейного зонда брать `model.get_image_features(...)`, нормировать, `sklearn.linear_model.LogisticRegression`.
- **ViTPose**: `VitPoseForPoseEstimation`; боксы в COCO xywh [V]; для ViTPose++ передавать `dataset_index` (0=COCO, 5=COCO-WholeBody) [V].
- **SAM 2.1**: `SAM2VideoPredictor`/`build_sam2_video_predictor` из репозитория; в README нет `transformers`-интеграции [V] (в новых версиях `Sam2Model` может быть, проверить).
- **ByteTrack**: `import supervision as sv; tracker = sv.ByteTrack(frame_rate=5)` (параметры времени пересчитать под 5 fps: `lost_track_buffer`, `track_activation_threshold`) [M]. Либо `from trackers import ByteTrackTracker` [V].
- **Hand detector**: 100DOH под PyTorch 1.0 и самосборку CUDA ops, тратить на него время не стоит.
- Кэшировать эмбеддинги/детекции на диск (parquet), чтобы подбор порогов гистерезиса шёл мгновенно без повторного инференса. Это главное ускорение подбора на хакатоне.

---

## 7. Известные риски и как их закрыть

| Риск | Эффект | Контрмера |
|---|---|---|
| Оверхед, люди видны сверху | Падает recall `person`, перепутаны боксы | Файнтюн D-FINE-M на псевдоразметке; поза-ключи как проверка |
| Телефон 15–25 px | Пропуски | Кроп вокруг кистей x3, SAHI-слайсинг, переход на 15 fps в окнах, фолбэк OWLv2 |
| Экран ноутбука мелкий/блик | lock vs unlocked неустойчиво | Яркость + энтропия + линейный зонд на реальных кропах; события по смене |
| Ключ в замке | почти не виден | Выдавать "вероятно", требовать подтверждения в >=3 соседних кадрах; кроп x4 |
| Стеклянная дверь | отражения, ложные состояния | Использовать косвенные признаки: треки у двери |
| ID-switch при перекрытии кассира и человека сзади | потеря события | OC-SORT, SAM2-маски, сшивка трекайлетов по цвету |
| Лицензионный дрейф | юридический риск | Список из раздела 1; CI-проверка импортов (`ultralytics`, `boxmot`) |
| Домен "неизвестный ракурс" | деградация | Open-vocab + якоря + нормированные пороги; валидация на отложенном ракурсе |

---

## 8. План на 24 часа

1. (1 ч) Окружение: `pip install transformers torch supervision trackers rtmlib onnxruntime scikit-learn opencv-python` (+ `rfdetr` по желанию). Проверка отсутствия AGPL-пакетов: `pip list | grep -Ei "ultralytics|boxmot"`.
2. (1 ч) Кэш кадров 5 fps + бенчмарк на 20 кадрах: D-FINE-M, OWLv2-B/16, SigLIP2-B на реальном железе (время на кадр, VRAM).
3. (3 ч) Детекция + ByteTrack + якоря + роль кассира, визуализация зон.
4. (3 ч) Сигналы: телефон, сумка/купюры, банкноты, объекты на столе.
5. (3 ч) Состояния SigLIP2: разметка 30–50 кропов на состояние, линейный зонд, проверка.
6. (2 ч) Events: гистерезис, склейка, JSON/CSV, аннотированное видео.
7. (3 ч) Отладка на всех клипах, подбор порогов по кэшу, при необходимости мини-файнтюн.
8. (2 ч) Отчёт, юридический список лицензий, резерв.

---

## 9. Источники

Проверено по первоисточнику при подготовке (отметка [V] в тексте):
- Grounding DINO 1.0: https://github.com/IDEA-Research/GroundingDINO
- Grounding DINO 1.5 API: https://github.com/idea-research/grounding-dino-1.5-api ; статья https://arxiv.org/abs/2405.10300
- YOLO-World: https://github.com/AILab-CVC/YOLO-World ; статья https://arxiv.org/abs/2401.17270
- YOLOE: https://github.com/THU-MIG/yoloe
- D-FINE: https://github.com/Peterande/D-FINE ; HF docs https://huggingface.co/docs/transformers/model_doc/d_fine
- DEIM / DEIMv2: https://github.com/Intellindust-AI-Lab/DEIM
- RF-DETR: https://github.com/roboflow/rf-detr
- YOLOX: https://github.com/Megvii-BaseDetection/YOLOX
- SAM 2: https://github.com/facebookresearch/sam2 ; SAM 3: https://github.com/facebookresearch/sam3
- MMPose: https://github.com/open-mmlab/mmpose ; RTMPose: https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose
- ViTPose в transformers: https://huggingface.co/docs/transformers/model_doc/vitpose
- OWLv2 в transformers: https://huggingface.co/docs/transformers/model_doc/owlv2 ; статья https://arxiv.org/abs/2306.09683
- 100DOH hand_object_detector: https://github.com/ddshan/hand_object_detector
- BoxMOT (AGPL): https://github.com/mikel-brostrom/boxmot ; roboflow/trackers: https://github.com/roboflow/trackers
- Florence-2: https://huggingface.co/microsoft/Florence-2-large-ft
- SigLIP 2 (через зеркала/листинги): https://docs.voxel51.com/model_zoo/models/google_siglip2_base_patch16_224.html

Известно по памяти / не открывалось в этой сессии (отметка [M], перед использованием перепроверить): лицензии ByteTrack/BoT-SORT/OC-SORT/supervision/OSNet/DINOv2/CLIP/ViTPose/RT-DETR, названия HF-чекпоинтов GDINO и SigLIP2 на оригинальных карточках, AP_S RT-DETR, FPS YOLO-World на V100, FPS GDINO 1.5 Edge, нативные порты Florence-2/SAM2 в `transformers`.
Оценки [E] (4090, CPU, OWLv2/GDINO/Florence-2/SigLIP2 FPS) не измерены.
