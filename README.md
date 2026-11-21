# PilotLocal  
Extensão para VSCodium para utilização de IA local  

## Contexto  
A extensão `PilotLocal` é um complemento para o **VSCodium** (ou VS Code) que permite integrar modelos de inteligência artificial **locais** (como Ollama, LLaMA, etc.) ao ambiente de desenvolvimento. Ela oferece funcionalidades para:  
- **Interagir com modelos de IA** via chat, incluindo a menção de arquivos específicos no código (`@arquivo.ts`)  
- **Gerenciar histórico de conversas** com o modelo  
- **Executar comandos personalizados** para manipulação de arquivos e IA  

---

## Funcionamento do Projeto  
### 1. **Arquitetura do Projeto**  
A extensão é desenvolvida em **TypeScript** e utiliza a API do VS Code para interagir com o ambiente. A arquitetura principal inclui:  
- **Backend (Node.js/TypeScript):** Lida com a lógica de interação com o modelo de IA (ex: Ollama), gerenciamento de arquivos e comunicação com o frontend.  
- **Frontend (Webview):** Uma interface web integrada no VS Code para exibir o chat, permitindo interação direta com o modelo.  
- **Comunicação Bidirecional:** O backend e o webview se comunicam via `postMessage` para enviar mensagens, arquivos e comandos.  

### 2. **Integração com IA Local**  
- O modelo de IA (ex: Ollama) é executado localmente no computador do usuário.  
- A extensão se conecta ao modelo via API (ex: REST ou gRPC) para enviar prompts e receber respostas.  
- **Menciona de arquivos:** Ao enviar uma mensagem com `@arquivo.ts`, o modelo recebe informações do conteúdo do arquivo, permitindo contextualização.  

### 3. **Webview e Interface do Usuário**  
- A interface do chat é exibida em um **webview** integrado ao VS Code.  
- O webview carrega um arquivo HTML/JavaScript local (`webview.html`) que renderiza o chat e lida com eventos de entrada do usuário.  
- **Comunicação com o backend:** O webview envia mensagens ao backend da extensão para processar comandos (ex: enviar prompt ao modelo).  

### 4. **Comandos e Funcionalidades**  
- **`Ollama: Adicionar ao Chat`:** Permite selecionar arquivos do projeto e adicioná-los ao chat para contextualizar a IA.  
- **`Ollama: Limpar Histórico do Chat`:** Remove o histórico de conversas para reiniciar a interação.  
- **`Ollama: Executar Comando`:** Executa ações personalizadas, como gerar código ou analisar arquivos.  

---

## Tecnologias Utilizadas  
- **TypeScript:** Linguagem de programação com tipagem estática para desenvolvimento seguro.  
- **Node.js:** Backend para interação com o modelo de IA e gerenciamento de arquivos.  
- **VS Code API:** Integração com o editor para funcionalidades como webviews e comandos.  
- **Webview:** Interface web para interação direta com o modelo.  
- **Ollama (ou outros modelos):** Modelo de IA local para processamento de linguagem natural.  

---

## Instalação  
1. **Clone o repositório:**  
   