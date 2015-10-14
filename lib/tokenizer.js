var tokens = {}
['require', 'embed', 'uri', 'dep', 'jsEmbed'].forEach(function( k ) {
    tokens[k] = function( content ) {
      return {
        type : k,
        content : content
      };
    };
});
tokens.text = function(content){
  return {
    type : 'plain_text',
    content : content
  }
};

function flatten( arr ) {
  return [].concat.apply([],arr);
}

function tokenizer ( reg, string, visitor ) {
  var token;
  var tokens = [];
  var start = 0;
  while( token = reg.exec(string) ){
    if(token.index != start){
      tokens.push( tokens.text( string.slice(start, token.index)) );
    } else {
      var ret = visitor.apply(null, token);
      if( !Array.isArray(ret) ){
        throw new Error('visitor must return an Array, but it return :', ret);
      }
      ret.forEach(function( token) {
        tokens.push(token);
      });
    }
  }
  return tokens;
}

function analyseComment(comment){
  var reg = /(@require\s+)('[^']+'|"[^"]+"|[^\s;!@#%^&*()]+)/g;
  return tokenizer(reg,contentfunction(m, prefix, value){
    return [tokens.text(prefix), tokens.require( value )];
  });
}


function extJs(content){
  var reg = /"(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|(\/\/[^\r\n\f]+|\/\*[\s\S]*?(?:\*\/|$))|\b(__inline|__uri|require)\s*\(\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*')\s*\)/g;
  return tokenizer(reg,content,function(m, comment, type, value){
    if(type){
      switch (type){
        case '__inline':
          return [tokens.jsEmbed(value)];
        case '__uri':
          return [tokens.uri(value)];
        case 'require':
          return [tokens.text('require('),tokens.require(value),tokens.text(')')];
      }
    } else if(comment){
      return analyseComment(comment);
    }
  });
}


function extCss(content){
  var reg = /(\/\*[\s\S]*?(?:\*\/|$))|(?:@import\s+)?\burl\s*\(\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|[^)}\s]+)\s*\)(\s*;?)|\bsrc\s*=\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|[^\s}]+)/g;
  var tokens = tokenizer(reg, content, function(m, comment, url, last, filter){
    if(url){
        var key = isInline(fis.util.query(url)) ? 'embed' : 'uri';
        if(m.indexOf('@') === 0){
          if(key === 'embed'){
            return [ tokens.embed( url ), tokens.text( last.replace(/;$/, '')) ];
          } else {
            return [ tokens.text( '@import url(' ), tokens.uri(url), tokens.text( ')' + last) ];
          }
        } else {
          return [ tokens.text( 'url(' ), tokens[key](url), tokens.text( ')' + last) ];
        }
    } else if(filter) {
      return [ tokens.text( 'src=' ), tokens.uri(filter)];
    } else if(comment) {
      return analyseComment(comment);
    }
  });
  return tokens;
}

function extHtml(content, callback){
  var reg = /(<script(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?=<\/script\s*>|$)|(<style(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?=<\/style\s*>|$)|<(img|embed|audio|video|link|object|source)\s+[\s\S]*?["'\s\w\/\-](?:>|$)|<!--inline\[([^\]]+)\]-->|<!--(?!\[)([\s\S]*?)(-->|$)/ig;
  return tokenizer(reg,content, function(m, $1, $2, $3, $4, $5, $6, $7, $8){
      if($1){//<script>
          var embed;
          $1 = tokenizer(/(\s(?:data-)?src\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig,$1, function(m, prefix, value){
              if(isInline(fis.util.query(value))){
                embed = tokens.embed(value);
                return [];
              } else {
                return [tokens.text(prefix), tokens.uri(value)];
              }
          });
          if(embed){
              //embed file
              m = flatten([$1, embed]);
          } else if(!/\s+type\s*=/i.test($1) || /\s+type\s*=\s*(['"]?)text\/javascript\1/i.test($1)) {
              //without attrubite [type] or must be [text/javascript]
              m = flatten([$1, extJs($2)]);
          } else {
              //other type as html
              m = flatten([$1, extHtml($2)]);
          }
      } else if($3){//<style>
          m = flatten([$3, extCss($4)]);
      } else if($5){//<img|embed|audio|video|link|object|source>
          var tag = $5.toLowerCase();
          if(tag === 'link'){
              var inline = [];
              var isCssLink = false;
              var isImportLink = false;
              var result = m.match(/\srel\s*=\s*('[^']+'|"[^"]+"|[^\s\/>]+)/i);
              if(result && result[1]){
                  var rel = result[1].replace(/^['"]|['"]$/g, '').toLowerCase();
                  isCssLink = rel === 'stylesheet';
                  isImportLink = rel === 'import';
              }
              m = tokenizer(/(\s(?:data-)?href\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, m, function(_, prefix, value){
                  if((isCssLink || isImportLink) && isInline(fis.util.query(value))){
                    if(isCssLink) {
                        inline.push( 
                          tokens.text( '<style' + m.substring(5).replace(/\/(?=>$)/, '').replace(/\s+(?:charset|href|data-href|hreflang|rel|rev|sizes|target)\s*=\s*(?:'[^']+'|"[^"]+"|[^\s\/>]+)/ig, ''))
                        );
                    }
                    inline.push(tokens.embed(value));
                    if(isCssLink) {
                      inline.push(tokens.text('</style>'));
                    }
                    return [];
                  } else {
                    return [tokens.text(prefix), tokens.uri(value)];
                  }
              });
              m = inline || m;
          } else if(tag === 'object'){
              m = tokenizer(/(\sdata\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, m, function(m, prefix, value){
                  return [tokens.text(prefix), tokens.uri(value)];
              });
          } else {
              m = tokenizer(/(\s(?:data-)?src\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, m, function(m, prefix, value){
                  var key = isInline(fis.util.query(value)) ? 'embed' : 'uri';
                  return [tokens.text(prefix), tokens[key](value)];
              });
              if (tag == 'img') {
                  //<img src="image-src.png" srcset="image-1x.png 1x, image-2x.png 2x, image-3x.png 3x, image-4x.png 4x">
                  //http://www.webkit.org/demos/srcset/
                  m = tokenizer(/(\ssrcset\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, m, function(m, prefix, value){
                      var info = fis.util.stringQuote(value);
                      var set = info.rest.split(',');
                      var imgset = [];

                      imgset.push( tokens.text(prefix + info.quote));

                      set.forEach(function (item) {
                          item = item.trim();
                          var p = item.indexOf(' ');
                          if (p == -1) {
                              imgset.push(item);
                              return;
                          }
                          imgset.push( tokens.uri(item.substr(0, p)) );
                          imgset.push( tokens.text(item.substr(p)) );
                      });

                      imgset.push( tokens.text(info.quote));
                      return imgset;
                  });
              }
          }
      } else if($6){
          m = tokens.embed($6);
      } else if($7){
          m = flatten([ tokens.text('<!--'), analyseComment($7), tokens.text($8)]);
      }
      return m;
  });
}


function extend_lang(file){
  var path = file.realpath;
  var content = file.getContent();
  var ast;

  if(typeof content === 'string'){
    fis.log.debug('standard start');
    //expand language ability
    if(file.isHtmlLike){
      ast = extHtml(content);
    } else if(file.isJsLike){
      ast = extJs(content);
    } else if(file.isCssLike){
      ast = extCss(content);
    }

    ast.forEach(function( node ) {
      var ret = '', info;
      var value = node.content;

      try{
        switch(node.type){
          case 'require':
              info = fis.uri.getId(value, file.dirname);
              file.addRequire(info.id);
              node.content = info.id;
              break;
          case 'uri':
              info = fis.uri(value, file.dirname);
              if(info.file && info.file.isFile()){
                if(embeddedCheck(file, info.file)){
                  exports(info.file);
                  addDeps(file, info.file);
                  node.content = info.id;
                }
              }
              break;
          case 'dep':
              if(file.cache){
                  info = fis.uri(value, file.dirname);
                  addDeps(file, info.file);
              } else {
                  fis.log.warning('unable to add deps to file [' + path + ']');
              }
              break;
          case 'embed':
          case 'jsEmbed':
              info = fis.uri(value, file.dirname);
              var f;
              if(info.file){
                  f = info.file;
              } else if(fis.util.isAbsolute(info.rest)){
                  f = fis.file(info.rest);
              }
              if(f && f.isFile()){
                if(embeddedCheck(file, f)){
                  exports(f);
                  addDeps(file, f);
                  f.requires.forEach(function(id){
                      file.addRequire(id);
                  });
                  node.content = f.id;
                }
              } else {
                  fis.log.error('unable to embed non-existent file [' + value + ']');
              }
              break;
          default :
              fis.log.error('unsupported fis language tag [' + type + ']');
        }
      } catch (e) {
        embeddedMap = {};
        e.message = e.message + ' in [' + file.subpath + ']';
        throw  e;
      }
    });
    fis.log.debug('standard end');

    file.setAst(ast);
  }
}
