//! Glossário de termos técnicos (versão personalizada).
//!
//! Três usos:
//! 1. **Dica para o Whisper** — os termos viram o "texto inicial" (initial prompt), que
//!    faz o modelo reconhecer melhor nomes e siglas específicos.
//! 2. **Correções automáticas** — pares "de → para" aplicados a cada trecho transcrito
//!    (vale para qualquer modelo, inclusive Parakeet).
//! 3. **Contexto do resumo** — a IA que gera a ata recebe a grafia correta dos termos.
//!
//! Fica salvo em `<dados do app>/Meetily/glossary.json` (no Windows, `%APPDATA%\Meetily`).

use once_cell::sync::Lazy;
use regex::{NoExpand, Regex};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Replacement {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Glossary {
    #[serde(default)]
    pub terms: Vec<String>,
    #[serde(default)]
    pub replacements: Vec<Replacement>,
}

struct Compiled {
    glossary: Glossary,
    rules: Vec<(Regex, String)>,
}

static STATE: Lazy<RwLock<Option<Compiled>>> = Lazy::new(|| RwLock::new(None));

/// Limite de caracteres do texto inicial do Whisper (o modelo aceita ~224 tokens).
const MAX_PROMPT_CHARS: usize = 600;

fn glossary_path() -> Option<PathBuf> {
    let mut p = dirs::data_dir()?;
    p.push("Meetily");
    p.push("glossary.json");
    Some(p)
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Remove espaços extras, linhas vazias e duplicados (sem diferenciar maiúsculas).
fn normalize(g: Glossary) -> Glossary {
    let mut seen = std::collections::HashSet::new();
    let terms = g
        .terms
        .into_iter()
        .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|t| !t.is_empty() && seen.insert(t.to_lowercase()))
        .collect();
    let replacements = g
        .replacements
        .into_iter()
        .map(|r| Replacement {
            from: r.from.split_whitespace().collect::<Vec<_>>().join(" "),
            to: r.to.trim().to_string(),
        })
        .filter(|r| !r.from.is_empty() && !r.to.is_empty() && r.from != r.to)
        .collect();
    Glossary { terms, replacements }
}

fn compile(glossary: Glossary) -> Compiled {
    let mut rules = Vec::new();
    for r in &glossary.replacements {
        // Espaços no termo de origem aceitam qualquer quantidade de espaços na transcrição
        let body = r
            .from
            .split(' ')
            .map(regex::escape)
            .collect::<Vec<_>>()
            .join(r"\s+");
        let starts_word = r.from.chars().next().map(is_word_char).unwrap_or(false);
        let ends_word = r.from.chars().last().map(is_word_char).unwrap_or(false);
        let pattern = format!(
            "(?i){}{}{}",
            if starts_word { r"\b" } else { "" },
            body,
            if ends_word { r"\b" } else { "" }
        );
        match Regex::new(&pattern) {
            Ok(re) => rules.push((re, r.to.clone())),
            Err(e) => log::warn!("Glossário: correção ignorada '{}': {}", r.from, e),
        }
    }
    Compiled { glossary, rules }
}

fn load_from_disk() -> Glossary {
    let Some(path) = glossary_path() else { return Glossary::default() };
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<Glossary>(&content)
            .map(normalize)
            .unwrap_or_else(|e| {
                log::warn!("Glossário inválido em {:?}: {}", path, e);
                Glossary::default()
            }),
        Err(_) => Glossary::default(),
    }
}

fn with_compiled<T>(f: impl FnOnce(&Compiled) -> T) -> T {
    {
        if let Ok(guard) = STATE.read() {
            if let Some(c) = guard.as_ref() {
                return f(c);
            }
        }
    }
    let compiled = compile(load_from_disk());
    let out = f(&compiled);
    if let Ok(mut guard) = STATE.write() {
        if guard.is_none() {
            *guard = Some(compiled);
        }
    }
    out
}

pub fn get() -> Glossary {
    with_compiled(|c| c.glossary.clone())
}

pub fn set(glossary: Glossary) -> Result<Glossary, String> {
    let glossary = normalize(glossary);
    if let Some(path) = glossary_path() {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Não foi possível criar a pasta: {}", e))?;
        }
        let json = serde_json::to_string_pretty(&glossary).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| format!("Não foi possível salvar o glossário: {}", e))?;
    }
    let compiled = compile(glossary.clone());
    if let Ok(mut guard) = STATE.write() {
        *guard = Some(compiled);
    }
    Ok(glossary)
}

/// Lista de termos com a grafia correta (termos + destino das correções), sem repetição.
fn correct_spellings(g: &Glossary) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    g.terms
        .iter()
        .cloned()
        .chain(g.replacements.iter().map(|r| r.to.clone()))
        .filter(|t| seen.insert(t.to_lowercase()))
        .collect()
}

fn build_whisper_prompt(g: &Glossary) -> Option<String> {
    let words = correct_spellings(g);
    if words.is_empty() {
        return None;
    }
    let mut prompt = String::from("Termos usados nesta reunião: ");
    let mut first = true;
    for w in words {
        let extra = if first { w.len() } else { w.len() + 2 };
        if prompt.len() + extra + 1 > MAX_PROMPT_CHARS {
            break;
        }
        if !first {
            prompt.push_str(", ");
        }
        prompt.push_str(&w);
        first = false;
    }
    prompt.push('.');
    Some(prompt)
}

/// Texto inicial para o Whisper, ou `None` se o glossário estiver vazio.
pub fn whisper_prompt() -> Option<String> {
    with_compiled(|c| build_whisper_prompt(&c.glossary))
}

fn apply_rules(rules: &[(Regex, String)], text: &str) -> String {
    let mut out = text.to_string();
    for (re, to) in rules {
        if re.is_match(&out) {
            out = re.replace_all(&out, NoExpand(to)).into_owned();
        }
    }
    out
}

/// Aplica as correções automáticas a um trecho transcrito.
pub fn apply_replacements(text: &str) -> String {
    with_compiled(|c| {
        if c.rules.is_empty() {
            text.to_string()
        } else {
            apply_rules(&c.rules, text)
        }
    })
}

/// Texto para orientar a IA do resumo, ou `None` se o glossário estiver vazio.
pub fn summary_context() -> Option<String> {
    with_compiled(|c| {
        let words = correct_spellings(&c.glossary);
        if words.is_empty() {
            return None;
        }
        let mut s = String::from(
            "Grafia correta de termos técnicos, nomes e siglas (use exatamente esta escrita no documento, \
             mesmo que a transcrição tenha escrito diferente):\n",
        );
        for w in words {
            s.push_str("- ");
            s.push_str(&w);
            s.push('\n');
        }
        for r in &c.glossary.replacements {
            s.push_str(&format!("- \"{}\" na transcrição significa \"{}\"\n", r.from, r.to));
        }
        Some(s)
    })
}

#[tauri::command]
pub fn glossary_get() -> Glossary {
    get()
}

#[tauri::command]
pub fn glossary_set(glossary: Glossary) -> Result<Glossary, String> {
    set(glossary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(terms: &[&str], reps: &[(&str, &str)]) -> Glossary {
        normalize(Glossary {
            terms: terms.iter().map(|s| s.to_string()).collect(),
            replacements: reps
                .iter()
                .map(|(f, t)| Replacement { from: f.to_string(), to: t.to_string() })
                .collect(),
        })
    }

    #[test]
    fn replacements_respect_words_and_case() {
        let c = compile(g(&[], &[("meta shape", "Metashape"), ("orto mosaico", "ortomosaico"), ("BCI", "BCI")]));
        assert_eq!(
            apply_rules(&c.rules, "Abrimos o Meta  Shape e o orto mosaico ficou pronto."),
            "Abrimos o Metashape e o ortomosaico ficou pronto."
        );
        // Não troca dentro de outras palavras
        let c = compile(g(&[], &[("gsd", "GSD")]));
        assert_eq!(apply_rules(&c.rules, "o gsd é bom, gsdx não"), "o GSD é bom, gsdx não");
        // Acentos contam como letra (limite de palavra Unicode)
        let c = compile(g(&[], &[("cadastro", "Cadastro")]));
        assert_eq!(apply_rules(&c.rules, "recadastro e cadastro."), "recadastro e Cadastro.");
        // "$" no destino não é interpretado
        let c = compile(g(&[], &[("real", "R$")]));
        assert_eq!(apply_rules(&c.rules, "um real"), "um R$");
    }

    #[test]
    fn whisper_prompt_lists_terms_once_and_is_bounded() {
        let gl = g(&["Metashape", "metashape", " ortomosaico "], &[("meta shape", "Metashape"), ("gsd", "GSD")]);
        assert_eq!(gl.terms, vec!["Metashape", "ortomosaico"]);
        let p = build_whisper_prompt(&gl).unwrap();
        assert_eq!(p, "Termos usados nesta reunião: Metashape, ortomosaico, GSD.");
        let many: Vec<String> = (0..500).map(|i| format!("termo{}", i)).collect();
        let big = normalize(Glossary { terms: many, replacements: vec![] });
        assert!(build_whisper_prompt(&big).unwrap().len() <= MAX_PROMPT_CHARS);
        assert!(build_whisper_prompt(&Glossary::default()).is_none());
    }
}
