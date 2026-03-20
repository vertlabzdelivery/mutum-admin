# Mutum Delivery • Painel admin

Painel administrativo enxuto para criar contas de restaurante, cadastrar restaurantes, gerenciar estados/cidades/bairros e gerar fechamentos de faturamento.

## Melhorias aplicadas
- correção da validação de sessão no boot
- tela de boot para evitar aparecer a tela errada por alguns instantes
- loading visual em login e formulários
- timeout de requisição para não travar silenciosamente
- README reorganizado e apresentação melhor do projeto

## Rodando localmente
1. Ajuste a API em `.env`:
   `API_BASE_URL=http://localhost:3001`
2. Inicie:
   `npm start`

Se estiver em produção/serverless, o painel usa `/api/proxy` automaticamente.
