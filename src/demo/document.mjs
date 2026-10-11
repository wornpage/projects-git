const guide=entrance=>`<section id="demo-guide" class="demo-guide" aria-labelledby="demo-guide-title">
  <h2 id="demo-guide-title" class="sr-only">Explore a completed project</h2>
  <p><strong>Read-only example.</strong> Invented records.</p>
  <button id="open-demo-guide" class="text-link" type="button" aria-haspopup="dialog" aria-controls="inspector-dialog">Example guide</button>
  <div id="demo-guide-body" class="demo-guide-content" hidden><p>Browsing runs no agents, checks or Git operations.</p><div id="demo-guide-steps"></div>
    <p class="demo-return"><a href="/">About Projects Git</a> · ${entrance ? '<a href="/workspace/">Sign in to private workspace</a>' : '<a href="https://github.com/wornpage/projects-git-challenge">Source and run instructions</a>'}</p>
  </div>
</section>`;

// One workbench document and renderer; the demo adds only its labeled entry context.
export function demoDocument(html,{entrance=false}={}){
  if((html.match(/<body>/g)??[]).length!==1||!html.includes('<div id="content"'))throw Error('Workbench document contract changed.');
  return html.replace('<body>','<body data-demo="read-only">')
    .replace('</head>','<link rel="stylesheet" href="/demo/demo.css"></head>')
    .replace('<div id="content"',guide(entrance)+'<div id="content"')
    .replace('<title>Projects Git — projects, agent work and decisions</title>','<title>Projects Git — read-only example</title>');
}
