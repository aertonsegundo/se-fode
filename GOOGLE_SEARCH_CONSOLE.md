# Google Search Console — o que fazer depois do deploy

Este passo a passo é para o **dono do domínio** e só funciona com o site já publicado
em `https://sefode.com`. Nada aqui pode ser feito pelo código: exige acesso à conta
Google e ao painel de DNS.

## Antes de começar

Confirme, no navegador, que estes endereços respondem:

- `https://sefode.com/`
- `https://sefode.com/fodinha-online`
- `https://sefode.com/como-jogar`
- `https://sefode.com/regras`
- `https://sefode.com/robots.txt`
- `https://sefode.com/sitemap.xml`

## Passo a passo

1. Entre em <https://search.google.com/search-console/> com a conta Google que vai
   administrar o site.
2. Clique em **Adicionar propriedade** e escolha o tipo **Domínio**. Digite
   `sefode.com` (sem `https://` e sem `www`). O tipo *Domínio* cobre de uma vez o
   site com e sem `www`, em HTTP e em HTTPS.
3. **Verifique pelo DNS.** O Google mostra um registro `TXT` do tipo
   `google-site-verification=...`. Copie esse valor, abra o painel onde o DNS de
   `sefode.com` é gerenciado (registrador ou provedor de DNS), crie um registro
   `TXT` na raiz do domínio (host `@`) com esse conteúdo e salve. Volte ao Search
   Console e clique em **Verificar**. A propagação costuma levar de alguns minutos
   a algumas horas — se falhar, espere e tente de novo.
4. Com a propriedade verificada, abra a seção **Sitemaps**, no menu da esquerda.
5. No campo "Adicionar novo sitemap", envie:

   ```
   https://sefode.com/sitemap.xml
   ```

   O status deve ficar como **Sucesso** e apontar 4 URLs descobertas.
6. Use a barra de busca do topo (**Inspeção de URL**) para inspecionar
   `https://sefode.com/`.
7. Clique em **Testar URL publicada**. Confira, em *Ver página testada → HTML*, que o
   `<title>`, a meta description e o `<h1>` aparecem no HTML retornado.
8. Clique em **Solicitar indexação** e aguarde a confirmação da fila.
9. Repita os passos 6 a 8 para cada página pública:
   - `https://sefode.com/fodinha-online`
   - `https://sefode.com/como-jogar`
   - `https://sefode.com/regras`
10. Acompanhe, nas semanas seguintes:
    - **Indexação de páginas** — quais URLs entraram e o motivo das que ficaram de fora.
    - **Desempenho** — impressões, cliques e as consultas que trazem gente ao site.
    - **Principais métricas da Web** (Core Web Vitals) — velocidade e estabilidade
      visual no celular e no computador.

## O que isso não garante

Enviar o sitemap e solicitar indexação **não garante posição nenhuma** no Google.
Isso apenas avisa ao buscador que as páginas existem e pede prioridade na fila de
rastreamento. Se e quando cada página vai aparecer, e em que posição para consultas
como "fodinha online", depende do algoritmo, da concorrência e do tempo — costuma
levar de dias a algumas semanas para as primeiras impressões aparecerem, e mais
tempo ainda para o ranqueamento estabilizar.

## Pendências fora do código

Estas configurações dependem do provedor de hospedagem/DNS e **não foram aplicadas**
por este projeto:

- **Domínio canônico.** Escolhemos `https://sefode.com` (sem `www`). Garanta no painel
  da hospedagem que `www.sefode.com` e as versões em HTTP redirecionem com **301** para
  `https://sefode.com`. No Render, isso se configura em *Settings → Custom Domains*:
  adicione os dois domínios e marque `sefode.com` como o principal — o `www` passa a
  redirecionar sozinho.
- **HTTPS.** O certificado é emitido automaticamente pelo Render; confirme que está
  ativo e que o redirecionamento de HTTP para HTTPS está ligado.
- O redirecionamento de `se-fode-online.onrender.com` para `https://sefode.com` já é
  feito pelo próprio servidor (308), exceto no `/health`.
