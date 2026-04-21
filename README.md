# Flow Image Stepper 🎬

Google Labs Flow에서 캐릭터 시트와 장면 이미지를 단계별로 생성하고, 긴 이미지 생성 작업을 이어가기 쉽게 도와주는 Chrome 확장 프로그램입니다.

## 주요 기능 ✨

Flow Image Stepper는 다음 상태를 확장 프로그램 저장소에 기록합니다.

- 붙여넣은 원본 프롬프트
- 파싱된 캐릭터 시트 프롬프트
- 파싱된 장면 프롬프트
- 다음에 생성할 캐릭터 위치
- 다음에 생성할 장면 위치
- Flow 생성 모델 설정
- 캐릭터 ID와 생성된 캐릭터 시트 이미지의 연결 정보
- 장면별 생성 이미지 URL과 파일명
- 마지막으로 성공한 체크포인트

이 확장은 브라우저를 다시 열었을 때 자동으로 생성을 재개하지 않습니다. 대신 Summary에 마지막 성공 지점과 다음 생성 지점을 보여주고, 사용자가 확인한 뒤 직접 버튼을 눌러 이어가도록 설계되어 있습니다.

## 기본 사용 흐름 🚦

1. Google Labs Flow 페이지를 엽니다.
2. Flow Image Stepper 사이드패널을 엽니다.
3. 전체 프롬프트 원문을 붙여넣습니다.
4. **Parse prompts**를 누릅니다.
5. **Next character**로 캐릭터 시트를 하나씩 생성합니다.
6. Summary의 캐릭터 참조 저장 상태를 확인합니다.
7. 필요하면 Model 설정을 **Nano Banana Pro** 또는 **Nano Banana 2**로 변경합니다.
8. **Next scene**으로 장면 이미지를 하나씩 생성합니다.
9. Flow에서는 이미지가 생성됐지만 확장 저장이 꼬였을 때는 **Recover scene**을 사용합니다.
10. 장면을 다시 생성해야 하면 **Back one scene**을 사용합니다.
11. 생성된 장면 이미지를 내려받을 때 **Download scene images**를 누릅니다.

## 저장 방식 💾

진행 상태는 Chrome 확장 프로그램 전용 저장소인 `chrome.storage.local`에 저장됩니다.

저장되는 주요 값은 다음과 같습니다.

- `source`: 사용자가 붙여넣은 원본 프롬프트
- `parsed`: 파싱된 캐릭터와 장면 데이터
- `characterIndex`: 다음에 생성할 캐릭터 위치
- `sceneIndex`: 다음에 생성할 장면 위치
- `model`: Flow 생성 모델 설정
- `characterRefs`: 캐릭터 ID별 캐릭터 시트 이미지 연결 정보와 생성 모델
- `sceneOutputs`: 장면별 생성 이미지 URL, 파일명, 생성 모델
- `checkpoint`: 마지막으로 성공한 캐릭터 또는 장면 단계

장면 이미지는 생성 직후 바로 다운로드하지 않습니다. 먼저 `sceneOutputs`에 이미지 URL과 파일명 정보를 저장하고, 나중에 **Download scene images** 버튼을 누르면 `chrome.downloads.download`로 다운로드합니다.

## 안전장치 🛡️

### 이어가기 지점 표시 🔁

Summary 상단에 마지막 성공 지점과 다음 생성 지점을 표시합니다.

예시:

```text
Resume point:
- Last success: Scene 017 at 2026-04-21 00:00:00
- Next character: done
- Next scene: 018
```

브라우저를 껐다 켠 뒤에도 이 정보를 보고 다음 장면부터 이어갈 수 있습니다.

### 캐릭터 참조 상태 표시 👤

각 캐릭터 시트가 확장 프로그램 내부에 저장되어 있는지 Summary에 표시합니다.

예시:

```text
Character reference status:
- Ch02_Main_CS-02 [done] saved / Nano Banana Pro
- Ch02_Support_CS-01 [next] missing
- Ch03_Villain_CS-01 [todo] missing
```

상태 의미:

- `[done] saved`: 생성이 끝났고 캐릭터 참조도 저장됨
- `[done] missing`: 진행상 끝난 캐릭터인데 참조 저장이 없음
- `[next] missing`: 다음에 생성해야 할 캐릭터
- `[todo] missing`: 아직 차례가 오지 않은 캐릭터

### 장면 저장 상태 표시 🖼️

각 장면마다 저장된 생성 이미지 개수를 Summary에 표시합니다.

예시:

```text
Scene output status:
- 001 [done] saved 2 / Nano Banana Pro: 001_Ch02_Main_CS-02_01, 001_Ch02_Main_CS-02_02
- 002 [next] saved 0: -
- 003 [todo] saved 0: -
```

모델을 중간에 바꿔가며 생성해도, 저장된 캐릭터 참조와 장면 출력에는 당시 사용한 모델명이 함께 기록됩니다.

### 캐릭터 참조 누락 검사 🚧

장면을 생성하기 전에 해당 장면에 필요한 캐릭터 참조가 모두 저장되어 있는지 검사합니다.

누락된 캐릭터 참조가 있으면 Flow에 프롬프트를 넣기 전에 멈추고, 로그에 빠진 캐릭터 ID를 표시합니다.

예시:

```text
Missing character reference(s) for scene 18: Ch02_Support_CS-01. Generate or recover them before running this scene.
```

## 버튼 설명 🧭

### Setup ⚙️

- **Parse prompts**: 붙여넣은 프롬프트를 파싱하고 진행 상태를 초기화합니다.
- **Clear saved prompt**: 저장된 프롬프트와 진행 상태를 지웁니다.
- **Model**: Flow에서 사용할 생성 모델을 선택합니다. 기본값은 **Nano Banana Pro**이며, 생성이 잘 되지 않을 때 **Nano Banana 2**로 바꿔 재시도할 수 있습니다.

### Generate ▶️

- **Next character**: 현재 차례의 캐릭터 시트를 생성하고 참조 정보를 저장합니다.
- **Next scene**: 필요한 캐릭터 참조를 확인한 뒤 현재 차례의 장면 이미지를 생성합니다.

### Recovery 🧯

- **Recover scene**: 현재 Flow 화면의 최근 이미지들을 현재 장면의 결과물로 저장합니다.
- **Back one scene**: 장면 진행 위치를 하나 되돌리고 해당 장면의 저장 결과를 제거합니다.

### Export 📦

- **Download scene images**: 저장된 장면 이미지들을 지정된 파일명으로 다운로드합니다.

## 파일명 형식 🏷️

장면 이미지 파일명은 장면 번호, 챕터, 참조 캐릭터 ID, 이미지 순번을 바탕으로 생성됩니다.

예시:

```text
001_Ch02_Main_CS-02_01.jpg
001_Ch02_Main_CS-02_02.jpg
002_Ch02_Support_CS-01_Ch02_Main_CS-02_01.jpg
```

## 설치 방법 🧩

1. Chrome에서 `chrome://extensions`를 엽니다.
2. **Developer mode**를 켭니다.
3. **Load unpacked**를 누릅니다.
4. 아래 폴더를 선택합니다.

```text
C:\Users\user\Desktop\Flow Image Stepper
```

코드를 수정한 뒤에는 `chrome://extensions`에서 확장 프로그램을 다시 로드해야 합니다.

## 추천 GitHub 저장소 이름 🐙

추천 저장소 이름:

```text
flow-image-stepper
```
