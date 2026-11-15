use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use slint::{ModelRc, VecModel};
use std::{cell::RefCell, rc::Rc, sync::{Arc, atomic::{AtomicBool, Ordering}}, thread};

slint::include_modules!();

const STORE_KEY: &str = "customai-native-v1";
const PRESETS: [(&str, &str, &str); 8] = [
    ("OpenAI", "openai", "https://api.openai.com/v1"),
    ("OpenRouter", "openai", "https://openrouter.ai/api/v1"),
    ("Groq", "openai", "https://api.groq.com/openai/v1"),
    ("DeepSeek", "openai", "https://api.deepseek.com/v1"),
    ("Ollama", "openai", "http://localhost:11434/v1"),
    ("LM Studio", "openai", "http://localhost:1234/v1"),
    ("Anthropic", "anthropic", "https://api.anthropic.com/v1"),
    ("Gemini", "gemini", "https://generativelanguage.googleapis.com/v1beta"),
];
const CAPABILITIES: &str = "\n\nИнтерфейс поддерживает Markdown-текст и таблицы. Если нужно задать вопрос с выбором, покажи вопрос и варианты обычным списком.";

#[derive(Clone, Serialize, Deserialize)]
struct Config {
    #[serde(default = "default_provider")] provider: String,
    #[serde(default)] endpoint: String,
    #[serde(default)] api_key: String,
    #[serde(default)] model: String,
    #[serde(default)] system: String,
    #[serde(default = "default_temp")] temperature: f32,
    #[serde(default = "default_theme")] theme: String,
}
fn default_provider() -> String { "openai".into() }
fn default_temp() -> f32 { 0.7 }
fn default_theme() -> String { "dark".into() }
impl Default for Config { fn default() -> Self { Self { provider: default_provider(), endpoint: String::new(), api_key: String::new(), model: String::new(), system: String::new(), temperature: default_temp(), theme: default_theme() } } }
#[derive(Clone, Serialize, Deserialize)]
struct Message { role: String, content: String, #[serde(default)] state: String }
#[derive(Clone, Serialize, Deserialize)]
struct Chat { id: String, title: String, messages: Vec<Message>, updated: u64 }
#[derive(Clone, Serialize, Deserialize, Default)]
struct Saved { config: Config, chats: Vec<Chat>, active: usize }

fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn storage_path() -> std::path::PathBuf {
    #[cfg(target_os = "android")] { if let Ok(dir) = std::env::var("HOME") { return std::path::PathBuf::from(dir).join("customai.json"); } }
    std::env::current_dir().unwrap_or_default().join("customai.json")
}
fn load() -> Saved { std::fs::read(storage_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default() }
fn save(data: &Saved) { if let Ok(b) = serde_json::to_vec_pretty(data) { let p = storage_path(); let tmp = p.with_extension("tmp"); if std::fs::write(&tmp, b).is_ok() { let _ = std::fs::rename(tmp, p); } } }
fn clean_endpoint(endpoint: &str) -> String { endpoint.trim().trim_end_matches('/').to_string() }
fn explain(status: u16, body: &str) -> String {
    let raw = serde_json::from_str::<Value>(body).ok().and_then(|v| v.pointer("/error/message").or(v.get("error"))).and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| body.chars().take(260).collect());
    match status { 401 | 403 => format!("API key отклонён ({status}). {raw}"), 404 => format!("Endpoint или модель не найдены (404). {raw}"), 429 => format!("Лимит запросов превышен (429). {raw}"), 500..=599 => format!("Ошибка сервера ({status}). {raw}"), _ if status >= 400 => format!("HTTP {status}. {raw}"), _ => raw }
}
fn content_text(v: &Value) -> String {
    if let Some(s) = v.as_str() { return s.into(); }
    if let Some(a) = v.as_array() { return a.iter().map(content_text).collect::<Vec<_>>().join(""); }
    if let Some(s) = v.get("text").and_then(Value::as_str) { return s.into(); }
    if let Some(s) = v.get("content").and_then(Value::as_str) { return s.into(); }
    String::new()
}
fn headers(cfg: &Config, builder: reqwest::blocking::RequestBuilder) -> reqwest::blocking::RequestBuilder {
    match cfg.provider.as_str() {
        "anthropic" => builder.header("anthropic-version", "2023-06-01").header("x-api-key", &cfg.api_key),
        "gemini" => builder.header("x-goog-api-key", &cfg.api_key),
        _ => builder.bearer_auth(&cfg.api_key),
    }
}
fn chat_url(cfg: &Config) -> String {
    let base = clean_endpoint(&cfg.endpoint);
    match cfg.provider.as_str() {
        "anthropic" => format!("{base}/messages"),
        "gemini" => format!("{base}/models/{}:streamGenerateContent?alt=sse", cfg.model),
        _ => format!("{base}/chat/completions"),
    }
}
fn make_body(cfg: &Config, messages: &[Message]) -> Value {
    match cfg.provider.as_str() {
        "anthropic" => {
            let msgs: Vec<Value> = messages.iter().filter(|m| m.role != "system").map(|m| json!({"role":m.role,"content":m.content})).collect();
            json!({"model":cfg.model,"max_tokens":4096,"stream":true,"temperature":cfg.temperature,"system":if cfg.system.trim().is_empty() { "".to_string() } else { format!("{}{}",cfg.system,CAPABILITIES) },"messages":msgs})
        }
        "gemini" => {
            let contents: Vec<Value> = messages.iter().filter(|m| m.role != "system").map(|m| json!({"role":if m.role=="assistant" {"model"} else {"user"},"parts":[{"text":m.content}]})).collect();
            let system = if cfg.system.trim().is_empty() { CAPABILITIES.to_string() } else { format!("{}{}",cfg.system,CAPABILITIES) };
            json!({"contents":contents,"systemInstruction":{"parts":[{"text":system}]},"generationConfig":{"temperature":cfg.temperature,"maxOutputTokens":4096}})
        }
        _ => {
            let mut msgs: Vec<Value> = Vec::new();
            let system = if cfg.system.trim().is_empty() { CAPABILITIES.to_string() } else { format!("{}{}",cfg.system,CAPABILITIES) };
            msgs.push(json!({"role":"system","content":system}));
            msgs.extend(messages.iter().map(|m| json!({"role":m.role,"content":m.content})));
            json!({"model":cfg.model,"messages":msgs,"temperature":cfg.temperature,"stream":true})
        }
    }
}
fn decode_event(event: &Value, provider: &str) -> (String, String) {
    if provider == "gemini" {
        let parts = event.pointer("/candidates/0/content/parts").and_then(Value::as_array).cloned().unwrap_or_default();
        return (parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""), String::new());
    }
    let delta = event.pointer("/choices/0/delta").or_else(|| event.pointer("/choices/0/message"));
    if let Some(d) = delta {
        return (content_text(d.get("content").unwrap_or(&Value::Null)), content_text(d.get("reasoning_content").or_else(||d.get("reasoning")).or_else(||d.get("thinking")).unwrap_or(&Value::Null)));
    }
    let ty = event.get("type").and_then(Value::as_str).unwrap_or("");
    let d = event.get("delta").unwrap_or(&Value::Null);
    if ty == "content_block_delta" {
        return match d.get("type").and_then(Value::as_str).unwrap_or("") { "text_delta" => (content_text(d.get("text").unwrap_or(&Value::Null)),String::new()), "thinking_delta" => (String::new(),content_text(d.get("thinking").unwrap_or(&Value::Null))), _ => (String::new(),String::new()) };
    }
    (String::new(),String::new())
}
fn collect_models(data: &Value) -> Vec<String> {
    let arr = data.as_array().or_else(|| data.get("data").and_then(Value::as_array)).or_else(|| data.get("models").and_then(Value::as_array));
    let mut out = arr.map(|a| a.iter().filter_map(|m| m.as_str().or_else(||m.get("id").and_then(Value::as_str)).or_else(||m.get("name").and_then(Value::as_str))).map(|s| s.trim_start_matches("models/").to_string()).collect::<Vec<_>>()).unwrap_or_default();
    out.sort(); out.dedup(); out
}
fn themes(cfg: &mut Config, ui: &AppWindow) {
    let (bg, panel, p2, ink, muted, accent, border) = match cfg.theme.as_str() {
        "light" => ("#f7f4ee","#ffffff","#ebe6dc","#1f1c18","#655e53","#a85a14","#dad3c6"),
        "black" => ("#0a0a0b","#161618","#1e1e21","#e8e8ea","#8d8d94","#7ba2ff","#28282c"),
        "oled" => ("#000000","#000000","#131316","#f2f2f4","#8a8a92","#63e6be","#1f1f22"),
        _ => ("#121110","#1f1d1b","#282623","#f1ede6","#a8a196","#e8a15c","#39352f"),
    };
    ui.set_bg(bg.into()); ui.set_panel(panel.into()); ui.set_panel_2(p2.into()); ui.set_ink(ink.into()); ui.set_muted(muted.into()); ui.set_accent(accent.into()); ui.set_border(border.into());
}
fn row_model<T: slint::Model + 'static>(items: Vec<T>) -> ModelRc<T> { ModelRc::new(VecModel::from(items)) }
fn refresh(ui: &AppWindow, data: &Saved, active: usize) {
    let chats: Vec<ChatRow> = data.chats.iter().enumerate().rev().filter(|(_,c)| !c.messages.is_empty()).map(|(i,c)| ChatRow { id: i.to_string().into(), title: c.title.clone().into(), selected: i == active }).collect();
    ui.set_chats(row_model(chats));
    let rows: Vec<MessageRow> = data.chats.get(active).map(|c| c.messages.iter().map(|m| MessageRow { role:m.role.clone().into(),content:m.content.clone().into(),state:m.state.clone().into() }).collect()).unwrap_or_default();
    ui.set_messages(row_model(rows));
    ui.set_title_text(data.chats.get(active).filter(|c| !c.messages.is_empty()).map(|c| c.title.clone()).unwrap_or_else(||"Новый чат".into()).into());
    ui.set_model_label(if data.config.model.is_empty() {"Подключить API".to_string()} else {data.config.model.clone()}.into());
    ui.set_endpoint(data.config.endpoint.clone().into()); ui.set_api_key(data.config.api_key.clone().into()); ui.set_model_id(data.config.model.clone().into()); ui.set_provider(data.config.provider.clone().into()); ui.set_system_prompt(data.config.system.clone().into()); ui.set_temperature(data.config.temperature);
}
fn add_empty_chat(data: &mut Saved) -> usize { data.chats.push(Chat { id:format!("{}",now()),title:"Новый чат".into(),messages:Vec::new(),updated:now() }); data.active=data.chats.len()-1; data.active }

fn launch_send(ui: AppWindow, state: Rc<RefCell<Saved>>, active: Rc<RefCell<usize>>, cancel: Arc<AtomicBool>, text: String) {
    let text=text.trim().to_string(); if text.is_empty() { return; }
    let (cfg, history, idx) = {
        let mut d=state.borrow_mut(); let mut i=*active.borrow(); if d.chats.is_empty() { i=add_empty_chat(&mut d); *active.borrow_mut()=i; }
        let Some(c)=d.chats.get_mut(i) else { return; };
        if d.config.endpoint.trim().is_empty() || d.config.model.trim().is_empty() { ui.set_status("Сначала укажите endpoint и модель в настройках.".into()); ui.set_settings_open(true); return; }
        let first=c.messages.is_empty(); c.messages.push(Message {role:"user".into(),content:text.clone(),state:"done".into()}); c.messages.push(Message {role:"assistant".into(),content:String::new(),state:"streaming".into()});
        if first { c.title=if text.chars().count()>48 {format!("{}…",text.chars().take(47).collect::<String>())} else {text.clone()}; }
        c.updated=now(); let history=c.messages.iter().take(c.messages.len()-1).cloned().collect::<Vec<_>>(); save(&d); (d.config.clone(),history,i)
    };
    ui.set_draft("".into()); ui.set_busy(true); ui.set_status("Подключение к модели…".into()); refresh(&ui,&state.borrow(),idx);
    cancel.store(false,Ordering::Relaxed);
    let ui_weak=ui.as_weak(); let state2=state.clone(); let active2=active.clone(); let cancel2=cancel.clone();
    thread::spawn(move || {
        let client=match reqwest::blocking::Client::builder().connect_timeout(std::time::Duration::from_secs(20)).timeout(std::time::Duration::from_secs(300)).build() { Ok(c)=>c,Err(e)=>{report(&ui_weak,&state2,&active2,idx,format!("HTTP client error: {e}"));return;} };
        let body=make_body(&cfg,&history); let url=chat_url(&cfg);
        let mut request=client.post(url).header("content-type","application/json");
        if cfg.provider=="anthropic" { request=request.header("anthropic-version","2023-06-01").header("x-api-key",cfg.api_key.clone()); }
        else if cfg.provider=="gemini" { request=request.header("x-goog-api-key",cfg.api_key.clone()); }
        else { request=request.bearer_auth(&cfg.api_key); }
        let response=match request.json(&body).send() {Ok(r)=>r,Err(e)=>{report(&ui_weak,&state2,&active2,idx,format!("Не удалось подключиться: {e}"));return;} };
        let status=response.status(); if !status.is_success() { let text=response.text().unwrap_or_default(); report(&ui_weak,&state2,&active2,idx,explain(status.as_u16(),&text));return; }
        let mut full=String::new(); let mut pending=String::new(); let provider=cfg.provider.clone();
        for line in response.bytes().chunks(1) {
            if cancel2.load(Ordering::Relaxed) { break; }
            let Ok(b)=line else { continue; }; pending.push_str(&String::from_utf8_lossy(b));
            if !pending.ends_with('\n') { continue; }
            let line=pending.trim().to_string(); pending.clear();
            let payload=if provider=="anthropic" || provider=="gemini" {line.strip_prefix("data:").map(str::trim)} else {line.strip_prefix("data:").map(str::trim)};
            let Some(payload)=payload else { continue; }; if payload.is_empty() || payload=="[DONE]" {continue;}
            if let Ok(event)=serde_json::from_str::<Value>(payload) {
                if event.get("type").and_then(Value::as_str)==Some("error") { report(&ui_weak,&state2,&active2,idx,explain(0,&event.to_string()));return; }
                let (chunk,reason)=decode_event(&event,&provider); let text=if chunk.is_empty(){reason}else{chunk};
                if !text.is_empty() { full.push_str(&text); let full2=full.clone(); let weak=ui_weak.clone(); let s=state2.clone(); let a=active2.clone(); slint::invoke_from_event_loop(move || { if let Some(ui)=weak.upgrade() { let mut d=s.borrow_mut(); if let Some(m)=d.chats.get_mut(idx).and_then(|c|c.messages.last_mut()) { if m.role=="assistant" {m.content=full2;} } refresh(&ui,&d,*a.borrow()); }}).ok(); }
            }
        }
        let weak=ui_weak.clone(); let s=state2.clone(); let a=active2.clone(); let cancelled=cancel2.load(Ordering::Relaxed);
        slint::invoke_from_event_loop(move || { if let Some(ui)=weak.upgrade() { let mut d=s.borrow_mut(); if let Some(chat)=d.chats.get_mut(idx) { if let Some(m)=chat.messages.last_mut() { if m.role=="assistant" {m.state=if cancelled {"done"} else if m.content.trim().is_empty(){"error"} else {"done"}.into(); if m.content.trim().is_empty() {m.content="Сервер вернул пустой ответ. Проверьте id модели и формат API.".into();} } } chat.updated=now(); } save(&d); ui.set_busy(false); ui.set_status(if cancelled {"Генерация остановлена".into()} else {"Готово".into()}); refresh(&ui,&d,*a.borrow()); }}).ok();
    });
}
fn report(weak:&slint::Weak<AppWindow>, state:&Rc<RefCell<Saved>>, active:&Rc<RefCell<usize>>, idx:usize, error:String) {
    let w=weak.clone(); let s=state.clone(); let a=active.clone(); slint::invoke_from_event_loop(move || {if let Some(ui)=w.upgrade(){let mut d=s.borrow_mut();if let Some(m)=d.chats.get_mut(idx).and_then(|c|c.messages.last_mut()){m.state="error".into();m.content=error.clone();} save(&d); ui.set_busy(false);ui.set_status(error.into());refresh(&ui,&d,*a.borrow());}}).ok();
}
fn request_models(ui:slint::Weak<AppWindow>, cfg:Config) {
    thread::spawn(move || {
        let client=match reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(30)).build(){Ok(c)=>c,Err(e)=>{let msg=e.to_string();slint::invoke_from_event_loop(move||if let Some(u)=ui.upgrade(){u.set_status(msg.into())}).ok();return;}};
        let path=match cfg.provider.as_str(){"anthropic"=>"/models?limit=100","gemini"=>"/models?pageSize=200",_=>"/models"};
        let url=format!("{}{}",clean_endpoint(&cfg.endpoint),path); let mut req=client.get(url);
        req=match cfg.provider.as_str(){"anthropic"=>req.header("anthropic-version","2023-06-01").header("x-api-key",cfg.api_key.clone()),"gemini"=>req.header("x-goog-api-key",cfg.api_key.clone()),_=>req.bearer_auth(&cfg.api_key)};
        let result=req.send().and_then(|r|{let status=r.status();let body=r.text()?;if !status.is_success(){return Err(reqwest::Error::from(std::io::Error::other(explain(status.as_u16(),&body))))}serde_json::from_str::<Value>(&body).map_err(|e|reqwest::Error::from(std::io::Error::other(e.to_string()))) });
        let status=result.map(|v|{let models=collect_models(&v);if models.is_empty(){"Модели не найдены в ответе API.".to_string()}else{format!("Модели: {}",models.join(", "))}}).unwrap_or_else(|e|format!("Ошибка списка моделей: {e}"));
        slint::invoke_from_event_loop(move||if let Some(u)=ui.upgrade(){u.set_status(status.into())}).ok();
    });
}
fn make_ui() -> Result<(), slint::PlatformError> {
    let ui=AppWindow::new()?; let saved=Rc::new(RefCell::new(load())); let active=Rc::new(RefCell::new(0usize)); let cancel=Arc::new(AtomicBool::new(false));
    if saved.borrow().chats.is_empty(){let mut d=saved.borrow_mut();add_empty_chat(&mut d);}
    *active.borrow_mut()=saved.borrow().active.min(saved.borrow().chats.len().saturating_sub(1));
    themes(&mut saved.borrow_mut().config,&ui); refresh(&ui,&saved.borrow(),*active.borrow());
    let s=saved.clone();let a=active.clone();let u=ui.as_weak();ui.on_new_chat(move||{let mut d=s.borrow_mut();let i=add_empty_chat(&mut d);*a.borrow_mut()=i;save(&d);if let Some(ui)=u.upgrade(){refresh(&ui,&d,i);}});
    let u=ui.as_weak();ui.on_open_settings(move||if let Some(x)=u.upgrade(){x.set_settings_open(true);});
    let s=saved.clone();let a=active.clone();let u=ui.as_weak();ui.on_select_chat(move|i|{let count=s.borrow().chats.len();if count>0{*a.borrow_mut()=i as usize;let mut d=s.borrow_mut();d.active=*a.borrow();save(&d);if let Some(x)=u.upgrade(){refresh(&x,&d,*a.borrow());}}});
    let s=saved.clone();let a=active.clone();let u=ui.as_weak();ui.on_delete_chat(move|i|{let mut d=s.borrow_mut();let idx=i as usize;if idx<d.chats.len(){d.chats.remove(idx);if d.chats.is_empty(){add_empty_chat(&mut d);}*a.borrow_mut()=(*a.borrow()).min(d.chats.len()-1);d.active=*a.borrow();save(&d);if let Some(x)=u.upgrade(){refresh(&x,&d,*a.borrow());}}});
    let s=saved.clone();let u=ui.as_weak();ui.on_save_settings(move|provider,endpoint,key,model,system,temp,theme|{let mut d=s.borrow_mut();d.config.provider=provider.to_string();d.config.endpoint=endpoint.to_string();d.config.api_key=key.to_string();d.config.model=model.to_string();d.config.system=system.to_string();d.config.temperature=temp;d.config.theme=theme.to_string();if d.config.endpoint.trim().is_empty()||d.config.model.trim().is_empty(){if let Some(x)=u.upgrade(){x.set_status("Укажите endpoint и модель.".into());return;}}d.config.endpoint=clean_endpoint(&d.config.endpoint);save(&d);if let Some(x)=u.upgrade(){x.set_settings_open(false);themes(&mut d.config,&x);x.set_status("Настройки сохранены локально".into());refresh(&x,&d,*active.borrow());}});
    let u=ui.as_weak();ui.on_choose_provider(move|provider|{if let Some(x)=u.upgrade(){let p=provider.to_string();let sel=match p.as_str(){"Anthropic"=>"anthropic","Gemini"=>"gemini",_=>"openai"};x.set_provider(sel.into());if let Some((_,_,ep))=PRESETS.iter().find(|(_,kind,_)|*kind==sel){x.set_endpoint((*ep).into());}}});
    let s=saved.clone();let u=ui.as_weak();ui.on_choose_theme(move|v|{if let Some(x)=u.upgrade(){let name=match v.as_str(){"Тёплая тёмная"=>"dark","Black"=>"black","OLED"=>"oled","Белая"=>"light",_=>"dark"};let mut d=s.borrow_mut();d.config.theme=name.into();themes(&mut d.config,&x);save(&d);}});
    let s=saved.clone();let u=ui.as_weak();ui.on_fetch_models(move||{if let Some(x)=u.upgrade(){let mut cfg=s.borrow().config.clone();cfg.endpoint=x.get_endpoint().to_string();cfg.api_key=x.get_api_key().to_string();cfg.model=x.get_model_id().to_string();cfg.provider=x.get_provider().to_string();x.set_status("Загружаю список моделей…".into());request_models(x.as_weak(),cfg);}});
    let s=saved.clone();let a=active.clone();let u=ui.as_weak();let c=cancel.clone();ui.on_send(move|text|{if let Some(x)=u.upgrade(){let mut d=s.borrow_mut();d.config.endpoint=x.get_endpoint().to_string();d.config.api_key=x.get_api_key().to_string();d.config.model=x.get_model_id().to_string();d.config.provider=x.get_provider().to_string();d.config.system=x.get_system_prompt().to_string();d.config.temperature=x.get_temperature();let _=d;launch_send(x,s.clone(),a.clone(),c.clone(),text.to_string());}});
    let c=cancel.clone();ui.on_stop_generation(move||{c.store(true,Ordering::Relaxed);});
    let s=saved.clone();let a=active.clone();let u=ui.as_weak();ui.on_clear_status(move||if let Some(x)=u.upgrade(){refresh(&x,&s.borrow(),*a.borrow());});
    ui.run()
}
pub fn run_desktop(){ if let Err(e)=make_ui(){eprintln!("SiteAI UI failed: {e}");} }
#[cfg(target_os="android")]
#[unsafe(no_mangle)]
pub fn android_main(app:slint::android::AndroidApp){if let Err(e)=slint::android::init(app){eprintln!("Slint Android backend failed: {e}");return;} run_desktop();}
