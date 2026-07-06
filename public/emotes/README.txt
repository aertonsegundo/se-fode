Imagens dos emotes
==================

Coloque aqui os arquivos de imagem dos emotes. Cada emote procura por
/emotes/<chave>.png. Se o arquivo NÃO existir, o jogo mostra o emoji
Unicode correspondente como fallback.

Formatos aceitos pelo navegador: use .png (recomendado, com fundo
transparente). Tamanho sugerido: ~128x128px.

Nomes de arquivo esperados (exatamente estes):

  joia.png       -> 👍  (dedo/joia)
  estiloso.png   -> 😎  (óculos escuros)
  raiva.png      -> 😡  (raiva)
  medo.png       -> 😨  (medo/nervoso)
  choro.png      -> 😭  (choro)
  lingua.png     -> 😝  (língua de fora)
  sorriso.png    -> 😁  (sorrisão)
  risada.png     -> 🤣  (risada)
  ideia.png      -> 💡  (ideia / lâmpada)
  fepe.png       -> 🍾  (Fepe)
  victin.png     -> 😐  (Victin)

Depois de salvar os arquivos, recarregue a página (Cmd+Shift+R). As
imagens passam a subir na tela no lugar dos emojis, automaticamente.

Para adicionar um emote novo: crie o arquivo aqui e adicione a chave em
EMOTES (server.js) e em EMOTE_LIST (public/app.js).
