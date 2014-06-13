var UNGROUPED = '__ungrouped__'; // reserved group id for ungrouped items

/**
 * An ItemSet holds a set of items and ranges which can be displayed in a
 * range. The width is determined by the parent of the ItemSet, and the height
 * is determined by the size of the items.
 * @param {{dom: Object, domProps: Object, emitter: Emitter, range: Range}} body
 * @param {Object} [options]      See Linegraph.setOptions for the available options.
 * @constructor ItemSet
 * @extends Component
 */
function Linegraph(body, options) {
  this.body = body;

  this.defaultOptions = {
    type: 'box',
    orientation: 'bottom',  // 'top' or 'bottom'
    align: 'center', // alignment of box items
    stack: true,
    groupOrder: null,

    selectable: true,
    editable: {
      updateTime: false,
      updateGroup: false,
      add: false,
      remove: false
    },

    onAdd: function (item, callback) {
      callback(item);
    },
    onUpdate: function (item, callback) {
      callback(item);
    },
    onMove: function (item, callback) {
      callback(item);
    },
    onRemove: function (item, callback) {
      callback(item);
    },

    margin: {
      item: 10,
      axis: 20
    },
    padding: 5
  };

  // options is shared by this ItemSet and all its items
  this.options = util.extend({}, this.defaultOptions);

  this.conversion = {
    toScreen: body.util.toScreen,
    toTime: body.util.toTime
  };
  this.dom = {};
  this.props = {};
  this.hammer = null;

  var me = this;
  this.itemsData = null;    // DataSet
  this.groupsData = null;   // DataSet

  // listeners for the DataSet of the items
  this.itemListeners = {
    'add': function (event, params, senderId) {
      me._onAdd(params.items);
    },
    'update': function (event, params, senderId) {
      me._onUpdate(params.items);
    },
    'remove': function (event, params, senderId) {
      me._onRemove(params.items);
    }
  };

  this.items = {};      // object with an Item for every data item
  this.selection = [];  // list with the ids of all selected nodes

  this.touchParams = {}; // stores properties while dragging
  // create the HTML DOM

  this._create();

  this.setOptions(options);
}

Linegraph.prototype = new Component();

// available item types will be registered here
Linegraph.types = {
  box: ItemBox,
  range: ItemRange,
  rangeoverflow: ItemRangeOverflow,
  point: ItemPoint
};

/**
 * Create the HTML DOM for the ItemSet
 */
Linegraph.prototype._create = function(){
  var frame = document.createElement('div');
  frame.className = 'linegraph';
  frame['linegraph'] = this;
  this.dom.frame = frame;

  // create background panel
  var background = document.createElement('div');
  background.className = 'background';
  frame.appendChild(background);
  this.dom.background = background;

  // create foreground panel
  var foreground = document.createElement('div');
  foreground.className = 'foreground';
  frame.appendChild(foreground);
  this.dom.foreground = foreground;

  // panel with time axis
  var dataAxisOptions = {
    range: this.range,
    left: null,
    top: null,
    width: null,
    height: 300,
    svg: this.svg
  };
  this.yAxis = new DataAxis(dataAxisOptions);
  this.dom.axis = this.yAxis.getFrame();


  this.show();
};


Linegraph.prototype.setOptions = function(options) {
  if (options) {
    // copy all options that we know
    var fields = ['type', 'align', 'orientation', 'padding', 'stack', 'selectable', 'groupOrder'];
    util.selectiveExtend(fields, this.options, options);

    if ('margin' in options) {
      if (typeof options.margin === 'number') {
        this.options.margin.axis = options.margin;
        this.options.margin.item = options.margin;
      }
      else if (typeof options.margin === 'object'){
        util.selectiveExtend(['axis', 'item'], this.options.margin, options.margin);
      }
    }

    if ('editable' in options) {
      if (typeof options.editable === 'boolean') {
        this.options.editable.updateTime  = options.editable;
        this.options.editable.updateGroup = options.editable;
        this.options.editable.add         = options.editable;
        this.options.editable.remove      = options.editable;
      }
      else if (typeof options.editable === 'object') {
        util.selectiveExtend(['updateTime', 'updateGroup', 'add', 'remove'], this.options.editable, options.editable);
      }
    }

    // callback functions
    var addCallback = (function (name) {
      if (name in options) {
        var fn = options[name];
        if (!(fn instanceof Function) || fn.length != 2) {
          throw new Error('option ' + name + ' must be a function ' + name + '(item, callback)');
        }
        this.options[name] = fn;
      }
    }).bind(this);
    ['onAdd', 'onUpdate', 'onRemove', 'onMove'].forEach(addCallback);

    // force the itemSet to refresh: options like orientation and margins may be changed

  }
};

/**
 * Hide the component from the DOM
 */
Linegraph.prototype.hide = function() {
  // remove the frame containing the items
  if (this.dom.frame.parentNode) {
    this.dom.frame.parentNode.removeChild(this.dom.frame);
  }

  // remove the labelset containing all group labels
  if (this.dom.axis.parentNode) {
    this.dom.axis.parentNode.removeChild(this.dom.axis);
  }
};

/**
 * Show the component in the DOM (when not already visible).
 * @return {Boolean} changed
 */
Linegraph.prototype.show = function() {
  // show frame containing the items
  if (!this.dom.frame.parentNode) {
    this.body.dom.center.appendChild(this.dom.frame);
  }

  // show labelset containing labels
  if (!this.dom.axis.parentNode) {
    this.body.dom.left.appendChild(this.dom.axis);
  }
};

/**
 * Repaint the component
 * @return {boolean} Returns true if the component is resized
 */
Linegraph.prototype.redraw = function() {
  // check whether zoomed (in that case we need to re-stack everything)
  var visibleInterval = this.range.end - this.range.start;
  var zoomed = (visibleInterval != this.lastVisibleInterval) || (this.width != this.lastWidth);
  if (zoomed) this.stackDirty = true;
  this.lastVisibleInterval = visibleInterval;
  this.lastWidth = this.width;

  // calculate actual size and position
  this.width = this.frame.offsetWidth;

  // check if this component is resized
  resized = this._isResized();

  if (resized) {
    this.svg.style.width = asSize(3*this.width);
    this.svg.style.left = asSize(-this.width);
  }
  if (zoomed) {
    this.updateGraph();
  }
};

/**
 * Get the first group, aligned with the axis
 * @return {Group | null} firstGroup
 * @private
 */
Linegraph.prototype._firstGroup = function() {
  var firstGroupIndex = (this.options.orientation == 'top') ? 0 : (this.groupIds.length - 1);
  var firstGroupId = this.groupIds[firstGroupIndex];
  var firstGroup = this.groups[firstGroupId] || this.groups[UNGROUPED];

  return firstGroup || null;
};

Linegraph.prototype.updateGraph = function() {
  if (this.width != 0) {
    var dataview = new DataView(this.timeline.itemsData,
      {filter: function (item) {return (item.value);}})

    var datapoints = dataview.get();
    if (datapoints != null) {
      if (datapoints.length > 0) {
        var dataset = this._extractData(datapoints);
        var data = dataset.data;

        console.log("height",data,datapoints, dataset);

        this.yAxis.setRange({start:dataset.range.low,end:dataset.range.high});
        this.yAxis.repaint();
        data = this.yAxis.convertValues(data);

        var d, d2, d3;
        d = this._catmullRom(data,0.5);
        d3 = this._catmullRom(data,0);
        d2 = this._catmullRom(data,1);


//        var data2 = [];
//        this.startTime = this.range.start;
//        var min = Date.now() - 3600000 * 24 * 30;
//        var max = Date.now() + 3600000 * 24 * 10;
//        var count = 60;
//        var step = (max-min) / count;
//
//        var range = this.range.end - this.range.start;
//        var rangePerPixel = range/this.width;
//        var rangePerPixelInv = this.width/range;
//        var xOffset = -this.range.start + this.width*rangePerPixel;
//
//        for (var i = 0; i < count; i++) {
//          data2.push({x:(min + i*step + xOffset) * rangePerPixelInv, y: 250*(i%2) + 25})
//        }
//
//        var d2 = this._catmullRom(data2);





        this.path.setAttributeNS(null, "d",d);
        this.path2.setAttributeNS(null, "d",d2);
        this.path3.setAttributeNS(null, "d",d3);
      }
    }
  }
}

/**
 * Set items
 * @param {vis.DataSet | null} items
 */
Linegraph.prototype.setItems = function(items) {

};


Linegraph.prototype._catmullRomUniform = function(data) {
  // catmull rom
  var p0, p1, p2, p3, bp1, bp2
  var d = "M" + Math.round(data[0].x) + "," + Math.round(data[0].y) + " ";
  var normalization = 1/6;
  var length = data.length;
  for (var i = 0; i < length - 1; i++) {

    p0 = (i == 0) ? data[0] : data[i-1];
    p1 = data[i];
    p2 = data[i+1];
    p3 = (i + 2 < length) ? data[i+2] : p2;


    // Catmull-Rom to Cubic Bezier conversion matrix
    //    0       1       0       0
    //  -1/6      1      1/6      0
    //    0      1/6      1     -1/6
    //    0       0       1       0

    //    bp0 = { x: p1.x,                               y: p1.y };
    bp1 = { x: ((-p0.x + 6*p1.x + p2.x) *normalization), y: ((-p0.y + 6*p1.y + p2.y) *normalization)};
    bp2 = { x: (( p1.x + 6*p2.x - p3.x) *normalization), y: (( p1.y + 6*p2.y - p3.y) *normalization)};
    //    bp0 = { x: p2.x,                               y: p2.y };

    d += "C" +
      Math.round(bp1.x) + "," +
      Math.round(bp1.y) + " " +
      Math.round(bp2.x) + "," +
      Math.round(bp2.y) + " " +
      Math.round(p2.x) + "," +
      Math.round(p2.y) + " ";
  }

  return d;
};


Linegraph.prototype._catmullRom = function(data, alpha) {
  if (alpha == 0 || alpha === undefined) {
    return this._catmullRomUniform(data);
  }
  else {
    var p0, p1, p2, p3, bp1, bp2, d1,d2,d3, A, B, N, M;
    var d3powA, d2powA, d3pow2A, d2pow2A, d1pow2A, d1powA;
    var d = "M" + Math.round(data[0].x) + "," + Math.round(data[0].y) + " ";
    var length = data.length;
    for (var i = 0; i < length - 1; i++) {

      p0 = (i == 0) ? data[0] : data[i-1];
      p1 = data[i];
      p2 = data[i+1];
      p3 = (i + 2 < length) ? data[i+2] : p2;

      d1 = Math.sqrt(Math.pow(p0.x - p1.x,2) + Math.pow(p0.y - p1.y,2));
      d2 = Math.sqrt(Math.pow(p1.x - p2.x,2) + Math.pow(p1.y - p2.y,2));
      d3 = Math.sqrt(Math.pow(p2.x - p3.x,2) + Math.pow(p2.y - p3.y,2));

      // Catmull-Rom to Cubic Bezier conversion matrix
      //
      // A = 2d1^2a + 3d1^a * d2^a + d3^2a
      // B = 2d3^2a + 3d3^a * d2^a + d2^2a
      //
      // [   0             1            0          0          ]
      // [   -d2^2a/N      A/N          d1^2a/N    0          ]
      // [   0             d3^2a/M      B/M        -d2^2a/M   ]
      // [   0             0            1          0          ]

      // [   0             1            0          0          ]
      // [   -d2pow2a/N    A/N          d1pow2a/N  0          ]
      // [   0             d3pow2a/M    B/M        -d2pow2a/M ]
      // [   0             0            1          0          ]

      d3powA  = Math.pow(d3,  alpha);
      d3pow2A = Math.pow(d3,2*alpha);
      d2powA  = Math.pow(d2,  alpha);
      d2pow2A = Math.pow(d2,2*alpha);
      d1powA  = Math.pow(d1,  alpha);
      d1pow2A = Math.pow(d1,2*alpha);

      A = 2*d1pow2A + 3*d1powA * d2powA + d2pow2A;
      B = 2*d3pow2A + 3*d3powA * d2powA + d2pow2A;
      N = 3*d1powA * (d1powA + d2powA);
      if (N > 0) {N = 1 / N;}
      M = 3*d3powA * (d3powA + d2powA);
      if (M > 0) {M = 1 / M;}

      bp1 = { x: ((-d2pow2A * p0.x + A*p1.x + d1pow2A * p2.x) * N),
        y: ((-d2pow2A * p0.y + A*p1.y + d1pow2A * p2.y) * N)};

      bp2 = { x: (( d3pow2A * p1.x + B*p2.x - d2pow2A * p3.x) * M),
        y: (( d3pow2A * p1.y + B*p2.y - d2pow2A * p3.y) * M)};

      if (bp1.x == 0 && bp1.y == 0) {bp1 = p1;}
      if (bp2.x == 0 && bp2.y == 0) {bp2 = p2;}
      d += "C" +
        Math.round(bp1.x) + "," +
        Math.round(bp1.y) + " " +
        Math.round(bp2.x) + "," +
        Math.round(bp2.y) + " " +
        Math.round(p2.x) + "," +
        Math.round(p2.y) + " ";
    }

    return d;
  }
};


Linegraph.prototype._linear = function(data) {
  // linear
  var d = "";
  for (var i = 0; i < data.length; i++) {
    if (i == 0) {
      d += "M" + data[i].x + "," + data[i].y;
    }
    else {
      d += " " + data[i].x + "," + data[i].y;
    }
  }
  return d;
}
