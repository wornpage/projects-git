const guide=entrance=>`<section id="demo-guide" class="demo-guide" aria-labelledby="demo-guide-title">
  <div><h2 id="demo-guide-title">Explore a completed project</h2><p>This is a read-only example with invented records. Browsing runs no agents, checks or Git operations.</p></div>
  <p class="demo-return"><a href="/">About Projects Git</a> · ${entrance ? '<a href="/workspace/">Sign in to private workspace</a>' : '<a href="https://github.com/wornpage/projects-git-challenge">Source and run instructions</a>'}</p>
</section>`;

// One workbench document and renderer; the demo adds only its labeled entry context.
export function demoDocument(html,{entrance=false}={}){
  if((html.match(/<body>/g)??[]).length!==1||!html.includes('<div id="content"'))throw Error('Workbench document contract changed.');
  return html.replace('<body>','<body data-demo="read-only">')
    .replace('</head>','<link rel="stylesheet" href="/demo/demo.css"></head>')
    .replace('<div id="content"',guide(entrance)+'<div id="content"')
    .replace('<title>Projects Git — projects, agent work and decisions</title>','<title>Projects Git — read-only example</title>');
}
