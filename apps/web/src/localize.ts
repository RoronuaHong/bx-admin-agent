import type { UiLocale } from "./ui-locale";
import type { LocalizedToken } from "./api";

export type LocalizedText = {
  zh: string;
  en: string;
  pt?: string;
  hi?: string;
};

export type LocalizedTextStrict = {
  zh: string;
  en: string;
  pt: string;
  hi: string;
};

export function pickLocalized(locale: UiLocale, item: LocalizedText): string {
  if (locale === "zh") return item.zh;
  if (locale === "pt-BR") return item.pt || item.en;
  if (locale === "hi") return item.hi || item.en;
  return item.en;
}

export function pickStrictLocalized(locale: UiLocale, item: LocalizedTextStrict): string {
  if (locale === "zh") return item.zh;
  if (locale === "pt-BR") return item.pt;
  if (locale === "hi") return item.hi;
  return item.en;
}

const GENERIC_FALLBACKS: Record<string, LocalizedTextStrict> = {
  GENERIC_UNKNOWN_ERROR: {
    zh: "操作失败，请稍后再试。",
    en: "Operation failed. Please try again later.",
    pt: "A operacao falhou. Tente novamente mais tarde.",
    hi: "कार्रवाई विफल हुई। कृपया बाद में फिर से प्रयास करें।",
  },
  GENERIC_AUTH_REQUIRED: {
    zh: "会话失效，请重新登录。",
    en: "Your session has expired. Please sign in again.",
    pt: "Sua sessao expirou. Faca login novamente.",
    hi: "आपका सत्र समाप्त हो गया है। कृपया फिर से साइन इन करें।",
  },
  GENERIC_NOT_FOUND: {
    zh: "目标不存在或已失效。",
    en: "The requested item was not found or is no longer available.",
    pt: "O item solicitado nao foi encontrado ou nao esta mais disponivel.",
    hi: "मांगा गया आइटम नहीं मिला या अब उपलब्ध नहीं है।",
  },
};

const TOKEN_TEXT: Record<string, LocalizedTextStrict> = {
  AUTH_NOT_LOGGED_IN: {
    zh: "未登录，请先登录。",
    en: "You are not signed in. Please sign in first.",
    pt: "Voce nao fez login. Faca login primeiro.",
    hi: "आप साइन इन नहीं हैं। कृपया पहले साइन इन करें।",
  },
  AUTH_SESSION_EXPIRED: GENERIC_FALLBACKS.GENERIC_AUTH_REQUIRED,
  AUTH_LOGIN_RATE_LIMITED: {
    zh: "登录尝试过于频繁，请稍后再试。",
    en: "Too many sign-in attempts. Please try again later.",
    pt: "Muitas tentativas de login. Tente novamente mais tarde.",
    hi: "साइन-इन प्रयास बहुत अधिक हैं। कृपया बाद में फिर से कोशिश करें।",
  },
  AUTH_LOGIN_MISSING_FIELDS: {
    zh: "请填写国家线、账号和密码。",
    en: "Please fill in country, username, and password.",
    pt: "Preencha pais, usuario e senha.",
    hi: "कृपया देश, उपयोगकर्ता नाम और पासवर्ड भरें।",
  },
  AUTH_COUNTRY_UNKNOWN: {
    zh: "国家线不存在或未配置。",
    en: "The selected country is unknown or not configured.",
    pt: "O pais selecionado e desconhecido ou nao esta configurado.",
    hi: "चयनित देश अज्ञात है या कॉन्फ़िगर नहीं है।",
  },
  AUTH_LOGIN_FAILED: {
    zh: "登录失败，请检查账号信息后重试。",
    en: "Sign-in failed. Please check your credentials and try again.",
    pt: "Falha no login. Verifique suas credenciais e tente novamente.",
    hi: "साइन-इन विफल हुआ। कृपया अपनी जानकारी जांचकर फिर से प्रयास करें।",
  },
  CHAT_EMPTY_INPUT: {
    zh: "请输入内容。",
    en: "Please enter a message.",
    pt: "Digite uma mensagem.",
    hi: "कृपया एक संदेश दर्ज करें।",
  },
  CHAT_RATE_LIMITED: {
    zh: "请求过于频繁，请稍后再试。",
    en: "Requests are too frequent. Please try again later.",
    pt: "As solicitacoes estao muito frequentes. Tente novamente mais tarde.",
    hi: "अनुरोध बहुत अधिक हैं। कृपया बाद में फिर से प्रयास करें।",
  },
  CHAT_TASK_RUNNING: {
    zh: "该会话已有任务在后台执行，本连接为进度回放；任务完成后结果会自动落入会话历史。",
    en: "A task for this conversation is already running in the background. This connection is replaying progress and the result will be saved to conversation history.",
    pt: "Ja existe uma tarefa em execucao em segundo plano para esta conversa. Esta conexao apenas reproduz o progresso, e o resultado sera salvo no historico.",
    hi: "इस वार्तालाप के लिए एक कार्य पहले से बैकग्राउंड में चल रहा है। यह कनेक्शन केवल प्रगति दिखा रहा है, और परिणाम वार्तालाप इतिहास में सहेजा जाएगा।",
  },
  CHAT_NO_RUNNING_TASK: {
    zh: "当前没有进行中的任务。",
    en: "There is no active task right now.",
    pt: "Nao ha nenhuma tarefa em andamento no momento.",
    hi: "अभी कोई सक्रिय कार्य नहीं है।",
  },
  CHAT_CONFIRM_MISSING_CALL_ID: {
    zh: "缺少确认标识。",
    en: "Missing confirmation identifier.",
    pt: "Falta o identificador de confirmacao.",
    hi: "पुष्टि पहचान गायब है।",
  },
  CHAT_CONTEXT_CLEAR_FAILED: {
    zh: "重置对话失败。",
    en: "Failed to reset the conversation.",
    pt: "Falha ao redefinir a conversa.",
    hi: "वार्तालाप रीसेट नहीं हो सका।",
  },
  CHAT_STREAM_FAILED: GENERIC_FALLBACKS.GENERIC_UNKNOWN_ERROR,
  CHAT_TASK_FAILED: {
    zh: "后台任务执行失败。",
    en: "The background task failed.",
    pt: "A tarefa em segundo plano falhou.",
    hi: "बैकग्राउंड कार्य विफल हो गया।",
  },
  STREAM_ERROR: GENERIC_FALLBACKS.GENERIC_UNKNOWN_ERROR,
  TRACE_FORBIDDEN: {
    zh: "无权限查看 Trace。",
    en: "You do not have permission to view Trace.",
    pt: "Voce nao tem permissao para ver o Trace.",
    hi: "आपको Trace देखने की अनुमति नहीं है।",
  },
  TRACE_RUN_NOT_FOUND: {
    zh: "该 Trace 不存在。",
    en: "The requested trace was not found.",
    pt: "O trace solicitado nao foi encontrado.",
    hi: "मांगा गया ट्रेस नहीं मिला।",
  },
  CHAT_CONVERSATION_NOT_FOUND: {
    zh: "会话不存在。",
    en: "The conversation was not found.",
    pt: "A conversa nao foi encontrada.",
    hi: "वार्तालाप नहीं मिला।",
  },
  CHAT_CONVERSATION_INVALID_MESSAGES: {
    zh: "消息列表格式无效。",
    en: "The messages payload is invalid.",
    pt: "O formato da lista de mensagens e invalido.",
    hi: "संदेश सूची का प्रारूप अमान्य है।",
  },
  CHAT_CONVERSATION_EMPTY_TITLE: {
    zh: "标题不能为空。",
    en: "The title cannot be empty.",
    pt: "O titulo nao pode ficar vazio.",
    hi: "शीर्षक खाली नहीं हो सकता।",
  },
  UPLOAD_NO_FILES: {
    zh: "未收到文件。",
    en: "No files were received.",
    pt: "Nenhum arquivo foi recebido.",
    hi: "कोई फ़ाइल प्राप्त नहीं हुई।",
  },
  UPLOAD_TOO_MANY_FILES: {
    zh: "一次最多上传 {maxCount} 个文件。",
    en: "You can upload up to {maxCount} files at a time.",
    pt: "Voce pode enviar ate {maxCount} arquivos por vez.",
    hi: "आप एक बार में अधिकतम {maxCount} फ़ाइलें अपलोड कर सकते हैं।",
  },
  UPLOAD_SAVE_FAILED: {
    zh: "文件保存失败。",
    en: "Failed to save the file.",
    pt: "Falha ao salvar o arquivo.",
    hi: "फ़ाइल सहेजी नहीं जा सकी।",
  },
  UPLOAD_FAILED: {
    zh: "上传失败。",
    en: "Upload failed.",
    pt: "Falha no envio.",
    hi: "अपलोड विफल हुआ।",
  },
  UPLOAD_IMAGE_NOT_FOUND: {
    zh: "图片不存在或已过期。",
    en: "The image was not found or has expired.",
    pt: "A imagem nao foi encontrada ou expirou.",
    hi: "चित्र नहीं मिला या उसकी समय-सीमा समाप्त हो गई।",
  },
  DOWNLOAD_FILE_NOT_FOUND: {
    zh: "文件不存在或已过期。",
    en: "The file was not found or has expired.",
    pt: "O arquivo nao foi encontrado ou expirou.",
    hi: "फ़ाइल नहीं मिली या उसकी समय-सीमा समाप्त हो गई।",
  },
  MODEL_QUOTA_EXHAUSTED: {
    zh: "模型服务额度已耗尽，请稍后重试或联系管理员。",
    en: "Model quota has been exhausted. Please try again later or contact an administrator.",
    pt: "A cota do modelo foi esgotada. Tente novamente mais tarde ou contate um administrador.",
    hi: "मॉडल कोटा समाप्त हो गया है। कृपया बाद में फिर से प्रयास करें या एडमिन से संपर्क करें।",
  },
  MODEL_CALL_FAILED: {
    zh: "模型服务调用失败，请稍后重试。",
    en: "The model service failed. Please try again later.",
    pt: "A chamada ao servico de modelo falhou. Tente novamente mais tarde.",
    hi: "मॉडल सेवा कॉल विफल हुई। कृपया बाद में फिर से प्रयास करें।",
  },
  VISION_OCR_FAILED: {
    zh: "图片识别失败，请稍后重试。",
    en: "Image recognition failed. Please try again later.",
    pt: "O reconhecimento de imagem falhou. Tente novamente mais tarde.",
    hi: "छवि पहचान विफल हुई। कृपया बाद में फिर से प्रयास करें।",
  },
  VISION_DISABLED: {
    zh: "当前模型不支持图片，请切换到支持图片的模型后重试。",
    en: "The current model does not support images. Please switch to an image-capable model and try again.",
    pt: "O modelo atual nao suporta imagens. Troque para um modelo com suporte a imagens e tente novamente.",
    hi: "वर्तमान मॉडल चित्रों का समर्थन नहीं करता। कृपया चित्र समर्थित मॉडल चुनकर फिर से प्रयास करें।",
  },
  CANCELLED: {
    zh: "已取消。",
    en: "Cancelled.",
    pt: "Cancelado.",
    hi: "रद्द किया गया।",
  },
  RECURSION_LIMIT: {
    zh: "本轮工具调用过多，已停止执行，请缩小范围后重试。",
    en: "Too many tool calls were made in this turn. Please narrow the request and try again.",
    pt: "Houve chamadas demais de ferramentas nesta rodada. Reduza o escopo e tente novamente.",
    hi: "इस चरण में बहुत अधिक टूल कॉल हुए। कृपया दायरा छोटा करके फिर से प्रयास करें।",
  },
  CONFIRM_WRITE_CODE_FILE: {
    zh: "即将写入代码文件，请确认是否继续。",
    en: "A code file is about to be written. Please confirm whether to continue.",
    pt: "Um arquivo de codigo sera alterado. Confirme se deseja continuar.",
    hi: "कोड फ़ाइल लिखी जाने वाली है। कृपया पुष्टि करें कि आगे बढ़ना है या नहीं।",
  },
  CONFIRM_GIT_COMMIT_PUSH: {
    zh: "即将提交并推送代码，请确认是否继续。",
    en: "Code is about to be committed and pushed. Please confirm whether to continue.",
    pt: "O codigo sera commitado e enviado. Confirme se deseja continuar.",
    hi: "कोड कमिट और पुश किया जाने वाला है। कृपया पुष्टि करें कि आगे बढ़ना है या नहीं।",
  },
  CONFIRM_CALL_API_WRITE: {
    zh: "即将执行写操作，请确认是否继续。",
    en: "A write operation is about to run. Please confirm whether to continue.",
    pt: "Uma operacao de escrita sera executada. Confirme se deseja continuar.",
    hi: "एक लिखने वाली कार्रवाई चलाई जाने वाली है। कृपया पुष्टि करें कि आगे बढ़ना है या नहीं।",
  },
  TRACE_DEGRADE_GENERIC: {
    zh: "上游状态异常，结果可能不稳定，请稍后重试或切换模型。",
    en: "The upstream service looks unstable. Results may be unreliable. Please try again later or switch models.",
    pt: "O servico upstream parece instavel. Os resultados podem ser inconsistentes. Tente novamente mais tarde ou troque o modelo.",
    hi: "अपस्ट्रीम सेवा अस्थिर लग रही है। परिणाम अविश्वसनीय हो सकते हैं। कृपया बाद में फिर से प्रयास करें या मॉडल बदलें।",
  },
  TOOL_SET_PROJECT_MISSING_FIELDS: {
    zh: "切换项目失败，缺少必要参数。",
    en: "Project switch failed because required fields are missing.",
    pt: "Falha ao trocar o projeto porque faltam campos obrigatorios.",
    hi: "प्रोजेक्ट बदलना विफल हुआ क्योंकि आवश्यक फ़ील्ड गायब हैं।",
  },
  TOOL_SET_PROJECT_UNKNOWN: {
    zh: "切换项目失败，目标项目不存在。",
    en: "Project switch failed because the target project was not found.",
    pt: "Falha ao trocar o projeto porque o projeto de destino nao foi encontrado.",
    hi: "प्रोजेक्ट बदलना विफल हुआ क्योंकि लक्ष्य प्रोजेक्ट नहीं मिला।",
  },
  TOOL_SET_PROJECT_FORBIDDEN: {
    zh: "当前账号无权访问该项目。",
    en: "Your account does not have access to this project.",
    pt: "Sua conta nao tem acesso a este projeto.",
    hi: "आपके खाते को इस प्रोजेक्ट तक पहुंच नहीं है।",
  },
  TOOL_SET_PROJECT_OK: {
    zh: "已切换到项目 {projectLabel}（{projectKey}）。后续请求会默认使用这个项目。",
    en: "Switched to project {projectLabel} ({projectKey}). Future requests will use this project by default.",
    pt: "Projeto alterado para {projectLabel} ({projectKey}). As proximas solicitacoes usarao este projeto por padrao.",
    hi: "प्रोजेक्ट {projectLabel} ({projectKey}) पर स्विच कर दिया गया है। आगे के अनुरोध डिफ़ॉल्ट रूप से इसी प्रोजेक्ट का उपयोग करेंगे।",
  },
  TOOL_ROUTE_WORKER_MISSING_DOMAIN: {
    zh: "切换 Worker 失败，缺少 domain 参数。",
    en: "Worker switch failed because the domain parameter is missing.",
    pt: "Falha ao trocar o Worker porque falta o parametro domain.",
    hi: "वर्कर बदलना विफल हुआ क्योंकि domain पैरामीटर गायब है।",
  },
  TOOL_ROUTE_WORKER_NOT_FOUND: {
    zh: "未找到匹配的 Worker。",
    en: "No matching worker was found.",
    pt: "Nenhum Worker correspondente foi encontrado.",
    hi: "कोई मेल खाता Worker नहीं मिला।",
  },
  TOOL_ROUTE_WORKER_OK: {
    zh: "已切换到 Worker {workerLabel}（{workerId}）。",
    en: "Switched to worker {workerLabel} ({workerId}).",
    pt: "Worker alterado para {workerLabel} ({workerId}).",
    hi: "Worker {workerLabel} ({workerId}) पर स्विच कर दिया गया है।",
  },
  TOOL_PREF_NO_OWNER: {
    zh: "当前无法识别用户，偏好未保存。",
    en: "The current user could not be identified, so preferences were not saved.",
    pt: "Nao foi possivel identificar o usuario atual, por isso as preferencias nao foram salvas.",
    hi: "वर्तमान उपयोगकर्ता की पहचान नहीं हो सकी, इसलिए प्राथमिकताएँ सहेजी नहीं गईं।",
  },
  TOOL_PREF_SAVE_FAILED: {
    zh: "保存偏好失败。",
    en: "Failed to save the preference.",
    pt: "Falha ao salvar a preferencia.",
    hi: "प्राथमिकता सहेजी नहीं जा सकी।",
  },
  TOOL_PREF_SAVED: {
    zh: "偏好已保存，后续会话会自动应用。",
    en: "The preference has been saved and will apply automatically in future conversations.",
    pt: "A preferencia foi salva e sera aplicada automaticamente nas proximas conversas.",
    hi: "प्राथमिकता सहेज ली गई है और आगे की बातचीत में अपने आप लागू होगी।",
  },
  TOOL_PREF_READ: {
    zh: "已读取当前用户偏好。",
    en: "The current user preferences have been loaded.",
    pt: "As preferencias atuais do usuario foram carregadas.",
    hi: "वर्तमान उपयोगकर्ता की प्राथमिकताएँ लोड कर ली गई हैं।",
  },
  TOOL_WRITE_FILE_MISSING_PATH: {
    zh: "写入文件失败，缺少路径参数。",
    en: "File write failed because the path parameter is missing.",
    pt: "Falha ao escrever o arquivo porque o parametro de caminho esta ausente.",
    hi: "फ़ाइल लिखना विफल हुआ क्योंकि path पैरामीटर गायब है।",
  },
  TOOL_WRITE_FILE_TOO_LARGE: {
    zh: "写入文件失败，内容超过大小限制。",
    en: "File write failed because the content exceeds the size limit.",
    pt: "Falha ao escrever o arquivo porque o conteudo excede o limite de tamanho.",
    hi: "फ़ाइल लिखना विफल हुआ क्योंकि सामग्री आकार सीमा से बड़ी है।",
  },
  TOOL_WRITE_FILE_OK: {
    zh: "已写入文件 {path}（{charCount} 字符）。",
    en: "Wrote file {path} ({charCount} characters).",
    pt: "Arquivo gravado em {path} ({charCount} caracteres).",
    hi: "{path} फ़ाइल लिख दी गई ({charCount} अक्षर)।",
  },
  TOOL_WRITE_FILE_FAILED: {
    zh: "写入文件失败。",
    en: "Failed to write the file.",
    pt: "Falha ao escrever o arquivo.",
    hi: "फ़ाइल लिखी नहीं जा सकी।",
  },
  TOOL_GIT_COMMIT_MISSING_MESSAGE: {
    zh: "提交失败，缺少提交信息。",
    en: "Commit failed because the commit message is missing.",
    pt: "Falha no commit porque a mensagem de commit esta ausente.",
    hi: "कमिट विफल हुआ क्योंकि commit message गायब है।",
  },
  TOOL_GIT_COMMIT_PROTECTED_BRANCH: {
    zh: "已阻止直接提交到受保护分支。",
    en: "Direct commits to a protected branch were blocked.",
    pt: "Commits diretos para uma branch protegida foram bloqueados.",
    hi: "सुरक्षित शाखा पर सीधे कमिट को रोक दिया गया।",
  },
  TOOL_GIT_BRANCH_NOT_FOUND: {
    zh: "目标分支不存在。",
    en: "The target branch was not found.",
    pt: "A branch de destino nao foi encontrada.",
    hi: "लक्ष्य शाखा नहीं मिली।",
  },
  TOOL_GIT_COMMIT_NO_CHANGES: {
    zh: "当前没有可提交的改动。",
    en: "There are no changes to commit.",
    pt: "Nao ha alteracoes para enviar em commit.",
    hi: "कमिट करने के लिए कोई बदलाव नहीं हैं।",
  },
  TOOL_GIT_COMMIT_PUSH_OK: {
    zh: "已完成提交并推送到 {branch}（{sha}）。",
    en: "Committed and pushed to {branch} ({sha}).",
    pt: "Commit e push concluidos em {branch} ({sha}).",
    hi: "{branch} ({sha}) पर कमिट और पुश पूरा हुआ।",
  },
  TOOL_GIT_COMMIT_OK: {
    zh: "已完成提交到 {branch}（{sha}），未执行推送。",
    en: "Committed to {branch} ({sha}) without pushing.",
    pt: "Commit concluido em {branch} ({sha}) sem push.",
    hi: "{branch} ({sha}) पर कमिट पूरा हुआ, लेकिन push नहीं किया गया।",
  },
  TOOL_GIT_COMMIT_FAILED: {
    zh: "Git 提交或推送失败。",
    en: "The Git commit or push failed.",
    pt: "Falha no commit ou push do Git.",
    hi: "Git commit या push विफल हुआ।",
  },
  TOOL_CALL_API_UNKNOWN_OPERATION: {
    zh: "接口调用失败，操作名未在索引中找到。",
    en: "API call failed because the operation name was not found in the index.",
    pt: "A chamada da API falhou porque o nome da operacao nao foi encontrado no indice.",
    hi: "API कॉल विफल हुआ क्योंकि operation नाम इंडेक्स में नहीं मिला।",
  },
  TOOL_CALL_API_PATH_NOT_INDEXED: {
    zh: "接口调用失败，请求路径未在索引中登记。",
    en: "API call failed because the request path is not registered in the index.",
    pt: "A chamada da API falhou porque o caminho da requisicao nao esta registrado no indice.",
    hi: "API कॉल विफल हुआ क्योंकि अनुरोध path इंडेक्स में पंजीकृत नहीं है।",
  },
  TOOL_CALL_API_BASE_URL_MISSING: {
    zh: "接口调用失败，当前环境缺少目标服务地址配置。",
    en: "API call failed because the target service URL is not configured for this environment.",
    pt: "A chamada da API falhou porque a URL do servico de destino nao esta configurada para este ambiente.",
    hi: "API कॉल विफल हुआ क्योंकि इस environment के लिए target service URL कॉन्फ़िगर नहीं है।",
  },
  TOOL_CALL_API_BASE_URL_MISSING_PROD: {
    zh: "接口调用失败，生产环境缺少目标服务地址配置。",
    en: "API call failed because the production service URL is not configured.",
    pt: "A chamada da API falhou porque a URL do servico de producao nao esta configurada.",
    hi: "API कॉल विफल हुआ क्योंकि production service URL कॉन्फ़िगर नहीं है।",
  },
  TOOL_CALL_API_REQUEST_FAILED: {
    zh: "接口调用失败，请检查网络或服务状态后重试。",
    en: "API call failed. Please check network or service availability and try again.",
    pt: "A chamada da API falhou. Verifique a rede ou a disponibilidade do servico e tente novamente.",
    hi: "API कॉल विफल हुआ। कृपया नेटवर्क या सेवा की उपलब्धता जांचकर फिर से प्रयास करें।",
  },
  TOOL_CALL_API_HTTP_ERROR: {
    zh: "接口调用失败，服务返回了 HTTP {status}。",
    en: "API call failed because the service returned HTTP {status}.",
    pt: "A chamada da API falhou porque o servico retornou HTTP {status}.",
    hi: "API कॉल विफल हुआ क्योंकि सेवा ने HTTP {status} लौटाया।",
  },
  TOOL_CALL_API_INVALID_URL: {
    zh: "接口调用失败，URL 格式无效。",
    en: "API call failed because the URL format is invalid.",
    pt: "A chamada da API falhou porque o formato da URL e invalido.",
    hi: "API कॉल विफल हुआ क्योंकि URL प्रारूप अमान्य है।",
  },
  TOOL_CALL_API_UNSUPPORTED_PROTOCOL: {
    zh: "接口调用失败，不支持该协议。",
    en: "API call failed because the protocol is not supported.",
    pt: "A chamada da API falhou porque o protocolo nao e suportado.",
    hi: "API कॉल विफल हुआ क्योंकि यह प्रोटोकॉल समर्थित नहीं है।",
  },
  TOOL_CALL_API_HOST_NOT_ALLOWED: {
    zh: "接口调用失败，目标主机不在允许列表中。",
    en: "API call failed because the target host is not on the allowlist.",
    pt: "A chamada da API falhou porque o host de destino nao esta na lista permitida.",
    hi: "API कॉल विफल हुआ क्योंकि लक्ष्य host allowlist में नहीं है।",
  },
  TOOL_GREP_MISSING_PATTERN: {
    zh: "代码检索失败，缺少搜索关键词。",
    en: "Code search failed because the search pattern is missing.",
    pt: "A busca no codigo falhou porque o padrao de pesquisa esta ausente.",
    hi: "कोड खोज विफल हुई क्योंकि search pattern गायब है।",
  },
  TOOL_GREP_FAILED: {
    zh: "代码检索失败。",
    en: "Code search failed.",
    pt: "A busca no codigo falhou.",
    hi: "कोड खोज विफल हुई।",
  },
  TOOL_GREP_READ_FILE_FAILED: {
    zh: "读取待检索文件失败。",
    en: "Failed to read the file being searched.",
    pt: "Falha ao ler o arquivo pesquisado.",
    hi: "खोजी जा रही फ़ाइल पढ़ी नहीं जा सकी।",
  },
  TOOL_GREP_NO_MATCH_FILE: {
    zh: "在文件中未找到匹配项。",
    en: "No matches were found in the file.",
    pt: "Nenhuma correspondencia foi encontrada no arquivo.",
    hi: "फ़ाइल में कोई मेल नहीं मिला।",
  },
  TOOL_GREP_NO_MATCH_DIR: {
    zh: "在搜索目录中未找到匹配项。",
    en: "No matches were found in the search directory.",
    pt: "Nenhuma correspondencia foi encontrada no diretorio pesquisado.",
    hi: "खोज निर्देशिका में कोई मेल नहीं मिला।",
  },
  TOOL_SEARCH_SYMBOL_MISSING_QUERY: {
    zh: "符号检索失败，缺少查询参数。",
    en: "Symbol search failed because the query is missing.",
    pt: "A busca de simbolos falhou porque a consulta esta ausente.",
    hi: "सिंबल खोज विफल हुई क्योंकि query गायब है।",
  },
  TOOL_SEARCH_SYMBOL_FAILED: {
    zh: "符号检索失败。",
    en: "Symbol search failed.",
    pt: "A busca de simbolos falhou.",
    hi: "सिंबल खोज विफल हुई।",
  },
  TOOL_SEARCH_API_MODULE_MISSING_QUERY: {
    zh: "模块检索失败，缺少查询参数。",
    en: "API module search failed because the query is missing.",
    pt: "A busca do modulo de API falhou porque a consulta esta ausente.",
    hi: "API मॉड्यूल खोज विफल हुई क्योंकि query गायब है।",
  },
  TOOL_SEARCH_API_MODULE_NOT_FOUND: {
    zh: "未找到匹配的接口模块。",
    en: "No matching API module was found.",
    pt: "Nenhum modulo de API correspondente foi encontrado.",
    hi: "कोई मेल खाता API मॉड्यूल नहीं मिला।",
  },
  TOOL_READ_API_MODULE_MISSING_MODULE: {
    zh: "读取接口源码失败，缺少模块参数。",
    en: "Reading API source failed because the module parameter is missing.",
    pt: "A leitura do codigo da API falhou porque o parametro do modulo esta ausente.",
    hi: "API सोर्स पढ़ना विफल हुआ क्योंकि module पैरामीटर गायब है।",
  },
  TOOL_FETCH_URL_INVALID: {
    zh: "链接抓取失败，URL 格式无效。",
    en: "URL fetch failed because the URL format is invalid.",
    pt: "A captura da URL falhou porque o formato da URL e invalido.",
    hi: "URL फ़ेच विफल हुआ क्योंकि URL प्रारूप अमान्य है।",
  },
  TOOL_FETCH_URL_FAILED: {
    zh: "链接抓取失败。",
    en: "URL fetch failed.",
    pt: "A captura da URL falhou.",
    hi: "URL फ़ेच विफल हुआ।",
  },
  TOOL_PREF_GUIDE: {
    zh: "已返回当前偏好说明。",
    en: "The current preference guide has been returned.",
    pt: "O guia de preferencias atual foi retornado.",
    hi: "वर्तमान प्राथमिकता मार्गदर्शिका लौटा दी गई है।",
  },
  TOOL_READ_LOCAL_MISSING_PATH: {
    zh: "读取本地文件失败，缺少路径参数。",
    en: "Reading a local file failed because the path parameter is missing.",
    pt: "A leitura do arquivo local falhou porque o parametro de caminho esta ausente.",
    hi: "स्थानीय फ़ाइल पढ़ना विफल हुआ क्योंकि path पैरामीटर गायब है।",
  },
  TOOL_READ_LOCAL_FAILED: {
    zh: "读取本地文件失败。",
    en: "Reading the local file failed.",
    pt: "A leitura do arquivo local falhou.",
    hi: "स्थानीय फ़ाइल पढ़ना विफल हुआ।",
  },
  TOOL_PARSE_INTENT_MISSING_INPUT: {
    zh: "意图解析失败，缺少用户输入。",
    en: "Intent parsing failed because the user input is missing.",
    pt: "A analise de intencao falhou porque a entrada do usuario esta ausente.",
    hi: "इंटेंट पार्सिंग विफल हुई क्योंकि user input गायब है।",
  },
  TOOL_NORMALIZE_OUTPUT_MISSING_MODULE: {
    zh: "结果规范化失败，缺少模块参数。",
    en: "Output normalization failed because the module parameter is missing.",
    pt: "A normalizacao da saida falhou porque o parametro do modulo esta ausente.",
    hi: "आउटपुट सामान्यीकरण विफल हुआ क्योंकि module पैरामीटर गायब है।",
  },
  TOOL_NORMALIZE_OUTPUT_MISSING_DATA: {
    zh: "结果规范化失败，缺少原始数据。",
    en: "Output normalization failed because the source data is missing.",
    pt: "A normalizacao da saida falhou porque os dados de origem estao ausentes.",
    hi: "आउटपुट सामान्यीकरण विफल हुआ क्योंकि source data गायब है।",
  },
  TOOL_NORMALIZE_OUTPUT_FAILED: {
    zh: "结果规范化失败。",
    en: "Output normalization failed.",
    pt: "A normalizacao da saida falhou.",
    hi: "आउटपुट सामान्यीकरण विफल हुआ।",
  },
  TOOL_SEARCH_KB_MISSING_QUERY: {
    zh: "知识库检索失败，缺少查询参数。",
    en: "Knowledge base search failed because the query is missing.",
    pt: "A busca na base de conhecimento falhou porque a consulta esta ausente.",
    hi: "नॉलेज बेस खोज विफल हुई क्योंकि query गायब है।",
  },
  TOOL_GET_FIELD_MAPPING_MISSING_MODULE: {
    zh: "读取字段映射失败，缺少模块参数。",
    en: "Reading field mappings failed because the module parameter is missing.",
    pt: "A leitura do mapeamento de campos falhou porque o parametro do modulo esta ausente.",
    hi: "फ़ील्ड मैपिंग पढ़ना विफल हुआ क्योंकि module पैरामीटर गायब है।",
  },
  TOOL_GET_LIST_COLUMNS_MISSING_TARGET: {
    zh: "读取列表列定义失败，缺少模块或路径参数。",
    en: "Reading list columns failed because both module and path are missing.",
    pt: "A leitura das colunas da lista falhou porque modulo e caminho estao ausentes.",
    hi: "सूची कॉलम पढ़ना विफल हुआ क्योंकि module और path दोनों गायब हैं।",
  },
  TOOL_GET_LIST_COLUMNS_NOT_FOUND: {
    zh: "未找到对应的列表列定义文件。",
    en: "No matching list column definition file was found.",
    pt: "Nenhum arquivo de definicao de colunas correspondente foi encontrado.",
    hi: "कोई मेल खाती सूची कॉलम परिभाषा फ़ाइल नहीं मिली।",
  },
  TOOL_GET_PAGE_SCHEMA_MISSING_MODULE: {
    zh: "读取页面结构失败，缺少模块参数。",
    en: "Reading the page schema failed because the module parameter is missing.",
    pt: "A leitura do schema da pagina falhou porque o parametro do modulo esta ausente.",
    hi: "पेज स्कीमा पढ़ना विफल हुआ क्योंकि module पैरामीटर गायब है।",
  },
  TOOL_GET_PAGE_SCHEMA_NOT_FOUND: {
    zh: "未找到匹配的页面结构。",
    en: "No matching page schema was found.",
    pt: "Nenhum schema de pagina correspondente foi encontrado.",
    hi: "कोई मेल खाता पेज स्कीमा नहीं मिला।",
  },
  TOOL_RENDER_TABLE_NO_DATA: {
    zh: "表格渲染失败，没有可用数据。",
    en: "Table rendering failed because no data was provided.",
    pt: "A renderizacao da tabela falhou porque nenhum dado foi fornecido.",
    hi: "तालिका रेंडरिंग विफल हुई क्योंकि कोई डेटा उपलब्ध नहीं था।",
  },
  TOOL_SUMMARIZE_CHART_MISSING_DATA: {
    zh: "图表摘要失败，缺少数据参数。",
    en: "Chart summarization failed because the data parameter is missing.",
    pt: "O resumo do grafico falhou porque o parametro de dados esta ausente.",
    hi: "चार्ट सारांश विफल हुआ क्योंकि data पैरामीटर गायब है।",
  },
  TOOL_SUMMARIZE_CHART_INVALID_SERIES: {
    zh: "图表摘要失败，无法解析数值序列。",
    en: "Chart summarization failed because no numeric series could be parsed.",
    pt: "O resumo do grafico falhou porque nenhuma serie numerica valida foi identificada.",
    hi: "चार्ट सारांश विफल हुआ क्योंकि कोई मान्य संख्यात्मक श्रृंखला पार्स नहीं हो सकी।",
  },
  TOOL_READ_FIELD_MAPPING_MISSING_MODULE: {
    zh: "读取字段映射失败，缺少模块参数。",
    en: "Reading field mappings failed because the module parameter is missing.",
    pt: "A leitura do mapeamento de campos falhou porque o parametro do modulo esta ausente.",
    hi: "फ़ील्ड मैपिंग पढ़ना विफल हुआ क्योंकि module पैरामीटर गायब है।",
  },
  TOOL_READ_FIELD_MAPPING_READ_FAILED: {
    zh: "读取字段映射文件失败。",
    en: "Reading the field mapping file failed.",
    pt: "A leitura do arquivo de mapeamento de campos falhou.",
    hi: "फ़ील्ड मैपिंग फ़ाइल पढ़ना विफल हुआ।",
  },
  TOOL_READ_FIELD_MAPPING_INVALID_JSON: {
    zh: "字段映射文件格式无效。",
    en: "The field mapping file is not valid JSON.",
    pt: "O arquivo de mapeamento de campos nao contem JSON valido.",
    hi: "फ़ील्ड मैपिंग फ़ाइल वैध JSON नहीं है।",
  },
  TOOL_EXPORT_DATASET_NO_DATA: {
    zh: "导出失败，没有可用数据。",
    en: "Export failed because no data was provided.",
    pt: "A exportacao falhou porque nenhum dado foi fornecido.",
    hi: "निर्यात विफल हुआ क्योंकि कोई डेटा उपलब्ध नहीं था।",
  },
  TOOL_SEARCH_SYMBOL_INDEX_MISSING: {
    zh: "符号检索不可用，索引尚未构建。",
    en: "Symbol search is unavailable because the index has not been built.",
    pt: "A busca de simbolos esta indisponivel porque o indice ainda nao foi gerado.",
    hi: "सिंबल खोज उपलब्ध नहीं है क्योंकि इंडेक्स अभी बनाया नहीं गया है।",
  },
  TOOL_SEARCH_SYMBOL_NO_MATCH: {
    zh: "符号索引中未找到匹配项。",
    en: "No matching entry was found in the symbol index.",
    pt: "Nenhuma entrada correspondente foi encontrada no indice de simbolos.",
    hi: "सिंबल इंडेक्स में कोई मेल नहीं मिला।",
  },
  TOOL_DINGTALK_SEARCH_MISSING_QUERY: {
    zh: "钉钉文档检索失败，缺少查询参数。",
    en: "DingTalk document search failed because the query is missing.",
    pt: "A busca de documentos do DingTalk falhou porque a consulta esta ausente.",
    hi: "DingTalk दस्तावेज़ खोज विफल हुई क्योंकि query गायब है।",
  },
  TOOL_DINGTALK_SEARCH_NOT_CONFIGURED: {
    zh: "钉钉文档检索尚未配置。",
    en: "DingTalk document search is not configured yet.",
    pt: "A busca de documentos do DingTalk ainda nao foi configurada.",
    hi: "DingTalk दस्तावेज़ खोज अभी कॉन्फ़िगर नहीं की गई है।",
  },
  TOOL_DINGTALK_SEARCH_NO_MATCH: {
    zh: "未找到匹配的钉钉文档。",
    en: "No matching DingTalk document was found.",
    pt: "Nenhum documento do DingTalk correspondente foi encontrado.",
    hi: "कोई मेल खाता DingTalk दस्तावेज़ नहीं मिला।",
  },
  TOOL_DINGTALK_SEARCH_FAILED: {
    zh: "钉钉文档检索失败。",
    en: "DingTalk document search failed.",
    pt: "A busca de documentos do DingTalk falhou.",
    hi: "DingTalk दस्तावेज़ खोज विफल हुई।",
  },
  TOOL_GET_FIELD_MAPPING_HINT: {
    zh: "枚举映射来自当前项目源码；如仍缺值，请继续读取源码确认。",
    en: "Enum mappings come from the current project source. Read the source further if values are still missing.",
    pt: "Os mapeamentos de enum foram extraidos do codigo atual do projeto. Leia o codigo-fonte se ainda faltarem valores.",
    hi: "एनम मैपिंग वर्तमान प्रोजेक्ट सोर्स से ली गई है। यदि मान अभी भी गायब हों तो आगे सोर्स पढ़ें।",
  },
  TOOL_GET_LIST_COLUMNS_HINT: {
    zh: "展示列表前可先使用这些列标题；取数后可继续配合表格渲染或字段对齐。",
    en: "Use these column titles before presenting a list; after fetching data you can continue with table rendering or output normalization.",
    pt: "Use estes titulos de coluna antes de apresentar a lista; depois da consulta, continue com renderizacao de tabela ou normalizacao da saida.",
    hi: "सूची दिखाने से पहले इन कॉलम शीर्षकों का उपयोग करें; डेटा लाने के बाद तालिका रेंडरिंग या आउटपुट नॉर्मलाइज़ेशन जारी रख सकते हैं।",
  },
  TOOL_GET_PAGE_SCHEMA_HINT_LIST: {
    zh: "列表页建议按表格方式展示结果。",
    en: "List pages should usually present results as a table.",
    pt: "Paginas de lista normalmente devem apresentar os resultados em tabela.",
    hi: "सूची पृष्ठों के परिणाम सामान्यतः तालिका के रूप में दिखाने चाहिए।",
  },
  TOOL_GET_PAGE_SCHEMA_HINT_ANALYSIS: {
    zh: "分析页建议输出摘要和关键点表，不要伪造图表。",
    en: "Analysis pages should return a summary plus key-point table instead of pretending to draw charts.",
    pt: "Paginas de analise devem retornar resumo e tabela de pontos-chave, sem fingir desenhar graficos.",
    hi: "विश्लेषण पृष्ठों में चार्ट का दिखावा करने के बजाय सारांश और मुख्य बिंदु तालिका लौटानी चाहिए।",
  },
  TOOL_GET_PAGE_SCHEMA_HINT_BI: {
    zh: "BI 页面建议说明入口，不要伪造数据。",
    en: "BI pages should describe the entry point and must not fabricate data.",
    pt: "Paginas de BI devem descrever a entrada e nao fabricar dados.",
    hi: "BI पृष्ठों में प्रवेश बिंदु बताना चाहिए और डेटा गढ़ना नहीं चाहिए।",
  },
  TOOL_GET_PAGE_SCHEMA_HINT_EDIT: {
    zh: "编辑页建议按区块描述；写操作缺参时先澄清必填项。",
    en: "Edit pages should be described in sections; clarify required fields before write actions.",
    pt: "Paginas de edicao devem ser descritas por secoes; esclareca os campos obrigatorios antes de escrever.",
    hi: "एडिट पृष्ठों को खंडों में वर्णित करें; लिखने वाली कार्रवाई से पहले आवश्यक फ़ील्ड स्पष्ट करें।",
  },
  TOOL_GET_PAGE_SCHEMA_HINT_DEFAULT: {
    zh: "请按页面类型选择合适的输出形态。",
    en: "Choose the response format according to the page type.",
    pt: "Escolha o formato de resposta de acordo com o tipo da pagina.",
    hi: "पेज प्रकार के अनुसार उपयुक्त उत्तर प्रारूप चुनें।",
  },
  TOOL_READ_FIELD_MAPPING_HINT_MISSING: {
    zh: "当前模块没有渲染规则配置，请继续从源码确认字段和枚举映射。",
    en: "This module has no render-rule config. Continue checking the source for field and enum mappings.",
    pt: "Este modulo nao possui configuracao de regras de renderizacao. Continue verificando o codigo-fonte para mapear campos e enums.",
    hi: "इस मॉड्यूल में render-rule config नहीं है। फ़ील्ड और enum mapping के लिए सोर्स की जांच जारी रखें।",
  },
  TOOL_READ_FIELD_MAPPING_HINT_FOUND: {
    zh: "当前结果是渲染规则配置，字段和枚举映射仍应以源码为准。",
    en: "This result contains render-rule config; field and enum mappings should still be verified from source.",
    pt: "Este resultado contem configuracao de regras de renderizacao; campos e enums ainda devem ser verificados no codigo-fonte.",
    hi: "इस परिणाम में render-rule config है; फ़ील्ड और enum mapping फिर भी सोर्स से सत्यापित करनी चाहिए।",
  },
};

function interpolate(template: string, params?: Record<string, string | number | boolean | null>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => String(params?.[key] ?? ""));
}

export function localizeToken(locale: UiLocale, token?: LocalizedToken | null, fallbackCode = "GENERIC_UNKNOWN_ERROR"): string {
  const item = token?.code ? TOKEN_TEXT[token.code] : undefined;
  if (item) return interpolate(pickStrictLocalized(locale, item), token?.params);
  const fallback = TOKEN_TEXT[fallbackCode] || GENERIC_FALLBACKS.GENERIC_UNKNOWN_ERROR;
  return interpolate(pickStrictLocalized(locale, fallback), token?.params);
}
