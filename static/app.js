/**
 * Nagini Web - Visual Script Composer
 * Main JavaScript application
 */

class NaginiApp {
  constructor() {
    this.blocks = [];
    this.nodes = [];
    this.connections = [];
    this.nextNodeId = 1;
    this.isDragging = false;
    this.draggedNode = null;
    this.dragOffset = { x: 0, y: 0 };
    this.isConnecting = false;
    this.connectionStart = null;
    this.tempLine = null;
    this.compositionName = "Untitled";
    this.savedCompositionId = null; // Track saved composition ID
    this.publishedScript = null; // Track published script data
    this.metadataUpdateTimeout = null;
    this.hasUnsavedChanges = false;
    this.selectedNode = null;
    this.variables = {}; // Store variable values { "variable_name": "value" }
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };
    this.panScrollStart = { x: 0, y: 0 };
    this.zoomLevel = 1;
    this.minZoom = 0.2;
    this.maxZoom = 3;

    // Load saved variables from localStorage
    this.loadVariables();

    this.init();
  }

  async init() {
    await this.loadBlocks();
    this.setupEventListeners();
    this.renderBlocks();

    // Check URL for composition parameter and auto-load
    const params = new URLSearchParams(window.location.search);
    const compositionName = params.get("composition");
    if (compositionName) {
      await this.loadCompositionByName(compositionName);
    }
  }

  updateUrlComposition(name) {
    const url = new URL(window.location);
    if (name) {
      url.searchParams.set("composition", name);
    } else {
      url.searchParams.delete("composition");
    }
    history.replaceState(null, "", url);
  }

  async loadCompositionByName(name) {
    try {
      const response = await fetch("/api/compositions");
      const compositions = await response.json();
      const match = compositions.find((c) => c.name === name);
      if (match) {
        await this.doLoad(match.id);
      } else {
        console.warn(`Composition "${name}" not found`);
      }
    } catch (error) {
      console.error("Error loading composition by name:", error);
    }
  }

  async loadBlocks() {
    try {
      const response = await fetch("/api/blocks");
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      this.blocks = Array.isArray(data) ? data : [];

      // Decode base64 content for each block
      this.blocks.forEach((block) => {
        if (block.content) {
          try {
            block.content = atob(block.content);
          } catch (e) {
            console.error(`Failed to decode content for block ${block.id}:`, e);
            block.content = "";
          }
        }
      });

      console.log(`Loaded ${this.blocks.length} blocks`);
    } catch (error) {
      console.error("Error loading blocks:", error);
      this.blocks = []; // Ensure blocks is always an array
    }
  }

  renderBlocks() {
    const blocksList = document.getElementById("blocksList");
    if (!blocksList) return;

    blocksList.innerHTML = "";

    // Safety check for blocks array
    if (!this.blocks || !Array.isArray(this.blocks)) {
      console.warn("No blocks available to render");
      return;
    }

    this.blocks.forEach((block) => {
      const blockItem = document.createElement("div");
      blockItem.className = "block-item";
      blockItem.draggable = true;
      blockItem.dataset.blockId = block.id;

      // Check if user is admin to show edit icon
      const isAdmin = window.currentUser && window.currentUser.role === "admin";
      const editIconHtml = isAdmin
        ? `<span class="block-edit-icon" data-edit-icon="true">E</span><span class="block-delete-icon" data-delete-icon="true">D</span>`
        : "";

      const tagsHtml = block.tags
        ? `<div class="block-tags">${block.tags
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t)
            .map((t) => `<span class="block-tag">${t}</span>`)
            .join("")}</div>`
        : "";

      blockItem.dataset.tags = block.tags || "";

      blockItem.innerHTML = `
                <div class="block-item-header">
                    <div class="block-name">${block.name}</div>
                    ${editIconHtml}
                </div>
                ${tagsHtml}
            `;

      // Add click handler to add block to canvas
      blockItem.addEventListener("click", (e) => {
        // Don't trigger if clicking on edit or delete icon
        if (
          e.target.closest(".block-edit-icon") ||
          e.target.closest(".block-delete-icon")
        ) {
          return;
        }

        // Add block with smart positioning to avoid overlap
        const canvas = document.getElementById("canvas");
        const canvasContainer = document.querySelector(".canvas-container");
        const scrollLeft = canvasContainer.scrollLeft;
        const scrollTop = canvasContainer.scrollTop;
        const containerWidth = canvasContainer.clientWidth;
        const containerHeight = canvasContainer.clientHeight;

        // Start position at center of visible area (account for zoom)
        let baseX = (scrollLeft + containerWidth / 2) / this.zoomLevel - 150;
        let baseY = (scrollTop + containerHeight / 2) / this.zoomLevel - 75;

        // Find non-overlapping position
        const position = this.findNonOverlappingPosition(baseX, baseY);
        this.addNode(block.id, position.x, position.y);
      });

      // Add edit icon click handler if admin
      if (isAdmin) {
        const editIcon = blockItem.querySelector(".block-edit-icon");
        if (editIcon) {
          editIcon.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.editBlock(block.id);
          });
          editIcon.addEventListener("mousedown", (e) => {
            e.stopPropagation();
          });
        }
      }

      // Add delete icon click handler if admin
      if (isAdmin) {
        const deleteIcon = blockItem.querySelector(".block-delete-icon");
        if (deleteIcon) {
          deleteIcon.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.deleteBlockDirect(block.id);
          });
          deleteIcon.addEventListener("mousedown", (e) => {
            e.stopPropagation();
          });
        }
      }

      blockItem.addEventListener("dragstart", (e) => {
        // Prevent drag if clicking on edit or delete icon
        if (
          e.target.closest(".block-edit-icon") ||
          e.target.closest(".block-delete-icon")
        ) {
          e.preventDefault();
          return false;
        }
        e.dataTransfer.setData("blockId", block.id);
        e.dataTransfer.effectAllowed = "copy";
      });

      blocksList.appendChild(blockItem);
    });
  }

  setupEventListeners() {
    const canvas = document.getElementById("canvas");

    // Drop event for adding nodes
    canvas.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });

    canvas.addEventListener("drop", (e) => {
      e.preventDefault();
      const blockId = e.dataTransfer.getData("blockId");
      if (blockId) {
        const canvasContainer = canvas.parentElement;
        const containerRect = canvasContainer.getBoundingClientRect();
        const x =
          (e.clientX - containerRect.left + canvasContainer.scrollLeft) /
          this.zoomLevel;
        const y =
          (e.clientY - containerRect.top + canvasContainer.scrollTop) /
          this.zoomLevel;
        this.addNode(blockId, x, y);
      }
    });

    // Global mouse events for dragging and connecting
    document.addEventListener("mousemove", (e) => this.handleMouseMove(e));
    document.addEventListener("mouseup", (e) => this.handleMouseUp(e));

    // Keyboard events for deletion
    document.addEventListener("keydown", (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedNode) {
        // Don't delete if user is typing in an input field
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
          return;
        }
        e.preventDefault();
        this.removeNode(this.selectedNode);
        this.selectedNode = null;
      }
    });

    // Click on canvas/container to deselect
    const canvasContainerEl = canvas.parentElement;
    canvasContainerEl.addEventListener("click", (e) => {
      if (e.target === canvas || e.target === canvasContainerEl) {
        this.deselectAllNodes();
      }
    });

    // Canvas panning - mousedown on empty space (canvas or container)
    canvasContainerEl.addEventListener("mousedown", (e) => {
      if (
        (e.target === canvas || e.target === canvasContainerEl) &&
        e.button === 0
      ) {
        this.isPanning = true;
        this.panStart = { x: e.clientX, y: e.clientY };
        this.panScrollStart = {
          x: canvasContainerEl.scrollLeft,
          y: canvasContainerEl.scrollTop,
        };
        canvasContainerEl.style.cursor = "grabbing";
        e.preventDefault();
      }
    });

    // Scroll-wheel zoom with zoom-to-cursor
    const canvasContainer = canvas.parentElement;
    canvasContainer.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();

        const oldZoom = this.zoomLevel;
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const newZoom = Math.min(
          this.maxZoom,
          Math.max(this.minZoom, oldZoom + delta),
        );
        if (newZoom === oldZoom) return;

        // Mouse position relative to the container viewport
        const containerRect = canvasContainer.getBoundingClientRect();
        const mouseX = e.clientX - containerRect.left;
        const mouseY = e.clientY - containerRect.top;

        // Canvas coordinate under the mouse cursor (before zoom change)
        const canvasX = (mouseX + canvasContainer.scrollLeft) / oldZoom;
        const canvasY = (mouseY + canvasContainer.scrollTop) / oldZoom;

        // Apply zoom
        this.zoomLevel = newZoom;
        canvas.style.transform = `scale(${this.zoomLevel})`;
        this.updateCanvasSize();

        // Adjust scroll so the same canvas point stays under the cursor
        canvasContainer.scrollLeft = canvasX * newZoom - mouseX;
        canvasContainer.scrollTop = canvasY * newZoom - mouseY;
      },
      { passive: false },
    );
  }

  addNode(blockId, x, y) {
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block) return;

    const nodeId = `node-${this.nextNodeId++}`;
    const node = {
      id: nodeId,
      blockId: blockId,
      blockName: block.name,
      x: x,
      y: y,
      connections: {
        input: null,
        output: [],
      },
    };

    this.nodes.push(node);
    this.renderNode(node);
    this.updateConnections();
    this.hasUnsavedChanges = true;
    this.savedCompositionId = null; // Clear saved ID on changes
    this.publishedScript = null; // Clear published script on changes
    this.updateMetadata();
    this.updateVariablesList(); // Update variables when nodes change
    this.autoOpenVariablesPanelIfNeeded(); // Auto-open if variables exist
  }

  renderNode(node) {
    const canvas = document.getElementById("canvas");
    const nodeElement = document.createElement("div");
    nodeElement.className = "script-node";
    nodeElement.id = node.id;
    nodeElement.style.position = "absolute";
    nodeElement.style.left = `${node.x}px`;
    nodeElement.style.top = `${node.y}px`;
    nodeElement.style.zIndex = "10";

    // Get the block content
    const block = this.blocks.find((b) => b.id === node.blockId);
    const blockContent = block ? block.content : "Script Block";
    const escapedContent = blockContent
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    nodeElement.innerHTML = `
            <div class="node-header" data-node-id="${node.id}">
                <span>${node.blockName}</span>
                <button class="node-remove" onclick="app.removeNode('${node.id}')">X</button>
            </div>
            <div class="node-body">
                <div style="position: relative;">
                    <div class="connection-point input" data-node-id="${node.id}" data-type="input"></div>
                    <pre style="margin: 0; padding: 5px 20px; color: #e0e0e0; font-size: 0.75rem; white-space: pre-wrap; word-break: break-word; max-width: 300px;">${escapedContent}</pre>
                    <div class="connection-point output" data-node-id="${node.id}" data-type="output"></div>
                </div>
            </div>
        `;

    canvas.appendChild(nodeElement);

    // Update canvas size after adding node
    setTimeout(() => this.updateCanvasSize(), 0);

    // Setup node selection
    nodeElement.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectNode(node.id);
    });

    // Setup dragging for node movement
    const header = nodeElement.querySelector(".node-header");
    header.addEventListener("mousedown", (e) => this.startDragging(e, node));

    // Setup connection points
    const inputPoint = nodeElement.querySelector(".connection-point.input");
    const outputPoint = nodeElement.querySelector(".connection-point.output");

    outputPoint.addEventListener("mousedown", (e) =>
      this.startConnection(e, node, "output"),
    );
    inputPoint.addEventListener("mouseup", (e) =>
      this.endConnection(e, node, "input"),
    );
  }

  reRenderNode(nodeId) {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const nodeElement = document.getElementById(nodeId);
    if (!nodeElement) return;

    // Get the updated block content
    const block = this.blocks.find((b) => b.id === node.blockId);
    if (!block) return;

    const escapedContent = block.content
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Update node name
    node.blockName = block.name;

    // Update the header
    const header = nodeElement.querySelector(".node-header span");
    if (header) {
      header.textContent = block.name;
    }

    // Update the content in the body
    const preElement = nodeElement.querySelector(".node-body pre");
    if (preElement) {
      preElement.innerHTML = escapedContent;
    }
  }

  startDragging(e, node) {
    if (e.target.classList.contains("node-remove")) return;

    e.preventDefault();
    this.isDragging = true;
    this.draggedNode = node;

    // Calculate offset of mouse within the node in canvas coordinates
    const canvas = document.getElementById("canvas");
    const canvasContainer = canvas.parentElement;
    const containerRect = canvasContainer.getBoundingClientRect();
    const mouseCanvasX =
      (e.clientX - containerRect.left + canvasContainer.scrollLeft) /
      this.zoomLevel;
    const mouseCanvasY =
      (e.clientY - containerRect.top + canvasContainer.scrollTop) /
      this.zoomLevel;

    this.dragOffset = {
      x: mouseCanvasX - node.x,
      y: mouseCanvasY - node.y,
    };
  }

  handleMouseMove(e) {
    if (this.isPanning) {
      const dx = e.clientX - this.panStart.x;
      const dy = e.clientY - this.panStart.y;
      const canvasContainer = document.querySelector(".canvas-container");
      canvasContainer.scrollLeft = this.panScrollStart.x - dx;
      canvasContainer.scrollTop = this.panScrollStart.y - dy;
      return;
    }

    if (this.isDragging && this.draggedNode) {
      const canvas = document.getElementById("canvas");
      const canvasContainer = canvas.parentElement;
      const containerRect = canvasContainer.getBoundingClientRect();

      const newX =
        (e.clientX - containerRect.left + canvasContainer.scrollLeft) /
          this.zoomLevel -
        this.dragOffset.x;
      const newY =
        (e.clientY - containerRect.top + canvasContainer.scrollTop) /
          this.zoomLevel -
        this.dragOffset.y;

      this.draggedNode.x = Math.max(0, newX);
      this.draggedNode.y = Math.max(0, newY);

      const nodeElement = document.getElementById(this.draggedNode.id);
      nodeElement.style.left = `${this.draggedNode.x}px`;
      nodeElement.style.top = `${this.draggedNode.y}px`;

      this.updateConnections();
      this.updateCanvasSize();
    } else if (this.isConnecting && this.tempLine) {
      // Update temporary connection line
      const canvas = document.getElementById("canvas");
      const canvasContainer = canvas.parentElement;
      const rect = canvas.getBoundingClientRect();
      const containerRect = canvasContainer.getBoundingClientRect();

      // Account for scroll position
      const x =
        (e.clientX - containerRect.left + canvasContainer.scrollLeft) /
        this.zoomLevel;
      const y =
        (e.clientY - containerRect.top + canvasContainer.scrollTop) /
        this.zoomLevel;

      this.tempLine.setAttribute("x2", x);
      this.tempLine.setAttribute("y2", y);
    }
  }

  handleMouseUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
      const canvasContainer = document.querySelector(".canvas-container");
      canvasContainer.style.cursor = "";
    }

    if (this.isDragging) {
      this.isDragging = false;
      this.draggedNode = null;
    }

    if (this.isConnecting) {
      this.cancelConnection();
    }
  }

  startConnection(e, node, type) {
    e.preventDefault();
    e.stopPropagation();

    this.isConnecting = true;
    this.connectionStart = { node, type };

    // Create temporary line
    const svg = document.getElementById("connections");
    const nodeElement = document.getElementById(node.id);
    const outputPoint = nodeElement.querySelector(".connection-point.output");
    const pointRect = outputPoint.getBoundingClientRect();
    const nodeRect = nodeElement.getBoundingClientRect();

    // Calculate position within the canvas coordinate system (divide screen-space offsets by zoom)
    const startX =
      node.x +
      (pointRect.left - nodeRect.left + pointRect.width / 2) / this.zoomLevel;
    const startY =
      node.y +
      (pointRect.top - nodeRect.top + pointRect.height / 2) / this.zoomLevel;

    this.tempLine = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "line",
    );
    this.tempLine.setAttribute("x1", startX);
    this.tempLine.setAttribute("y1", startY);
    this.tempLine.setAttribute("x2", startX);
    this.tempLine.setAttribute("y2", startY);
    this.tempLine.setAttribute("stroke", "#4a9eff");
    this.tempLine.setAttribute("stroke-width", "2");
    this.tempLine.setAttribute("stroke-dasharray", "5,5");

    svg.appendChild(this.tempLine);
  }

  endConnection(e, targetNode, targetType) {
    if (!this.isConnecting || !this.connectionStart) return;

    e.preventDefault();
    e.stopPropagation();

    const sourceNode = this.connectionStart.node;

    // Don't allow self-connections
    if (sourceNode.id === targetNode.id) {
      this.cancelConnection();
      return;
    }

    // Check if connection already exists
    const existingConnection = this.connections.find(
      (c) => c.from === sourceNode.id && c.to === targetNode.id,
    );

    if (!existingConnection) {
      // Remove any existing output connection from the source node
      const oldOutputConnection = this.connections.find(
        (c) => c.from === sourceNode.id,
      );
      if (oldOutputConnection) {
        this.removeConnection(oldOutputConnection);
      }

      // Remove any existing input connection to the target
      const oldInputConnection = this.connections.find(
        (c) => c.to === targetNode.id,
      );
      if (oldInputConnection) {
        this.removeConnection(oldInputConnection);
      }

      // Add new connection
      this.connections.push({
        from: sourceNode.id,
        to: targetNode.id,
      });

      sourceNode.connections.output = [targetNode.id];
      targetNode.connections.input = sourceNode.id;
    }

    this.cancelConnection();
    this.updateConnections();
    this.hasUnsavedChanges = true;
    this.savedCompositionId = null; // Clear saved ID on changes
    this.publishedScript = null; // Clear published script on changes
    this.updateMetadata();
    this.updateVariablesList(); // Update variables when nodes are removed
  }

  cancelConnection() {
    this.isConnecting = false;
    this.connectionStart = null;

    if (this.tempLine) {
      this.tempLine.remove();
      this.tempLine = null;
    }
  }

  removeConnection(connection) {
    const fromNode = this.nodes.find((n) => n.id === connection.from);
    const toNode = this.nodes.find((n) => n.id === connection.to);

    if (fromNode) {
      fromNode.connections.output = fromNode.connections.output.filter(
        (id) => id !== connection.to,
      );
    }

    if (toNode) {
      toNode.connections.input = null;
    }

    this.connections = this.connections.filter(
      (c) => !(c.from === connection.from && c.to === connection.to),
    );
  }

  getMainChain() {
    // Find all connected components and return the largest one
    const visited = new Set();
    const components = [];

    const findComponent = (nodeId) => {
      const component = new Set();
      const queue = [nodeId];

      while (queue.length > 0) {
        const currentId = queue.shift();
        if (visited.has(currentId)) continue;

        const node = this.nodes.find((n) => n.id === currentId);
        if (!node) continue; // Skip if node doesn't exist

        visited.add(currentId);
        component.add(currentId);

        // Add connected nodes to queue (only if they exist)
        if (node.connections.input) {
          const inputNode = this.nodes.find(
            (n) => n.id === node.connections.input,
          );
          if (inputNode) {
            queue.push(node.connections.input);
          }
        }
        node.connections.output.forEach((outId) => {
          const outputNode = this.nodes.find((n) => n.id === outId);
          if (outputNode) {
            queue.push(outId);
          }
        });
      }

      return component;
    };

    // Find all components
    this.nodes.forEach((node) => {
      if (!visited.has(node.id)) {
        const component = findComponent(node.id);
        if (component.size > 0) {
          components.push(component);
        }
      }
    });

    // Return the largest component (or empty set if no nodes)
    if (components.length === 0) return new Set();
    return components.reduce((largest, current) =>
      current.size > largest.size ? current : largest,
    );
  }

  updateNodeStyles() {
    const mainChain = this.getMainChain();

    this.nodes.forEach((node) => {
      const nodeElement = document.getElementById(node.id);
      if (!nodeElement) return;

      if (mainChain.has(node.id)) {
        nodeElement.classList.remove("inactive");
      } else {
        nodeElement.classList.add("inactive");
      }
    });
  }

  updateCanvasSize() {
    const canvas = document.getElementById("canvas");
    const svg = document.getElementById("connections");
    if (!canvas || this.nodes.length === 0) return;

    // Find the maximum x and y positions of all nodes
    let maxX = 0;
    let maxY = 0;

    this.nodes.forEach((node) => {
      const nodeElement = document.getElementById(node.id);
      if (nodeElement) {
        const nodeRect = nodeElement.getBoundingClientRect();
        const nodeRight = node.x + nodeRect.width / this.zoomLevel;
        const nodeBottom = node.y + nodeRect.height / this.zoomLevel;

        maxX = Math.max(maxX, nodeRight);
        maxY = Math.max(maxY, nodeBottom);
      }
    });

    // Add padding to ensure there's space around the nodes
    const padding = 100;
    const containerWidth = canvas.parentElement.clientWidth;
    const containerHeight = canvas.parentElement.clientHeight;
    const minWidth = containerWidth / this.zoomLevel;
    const minHeight = containerHeight / this.zoomLevel;

    const logicalWidth = Math.max(minWidth, maxX + padding);
    const logicalHeight = Math.max(minHeight, maxY + padding);

    canvas.style.width = logicalWidth * this.zoomLevel + "px";
    canvas.style.height = logicalHeight * this.zoomLevel + "px";

    // Update SVG size to match logical canvas size
    if (svg) {
      svg.style.width = logicalWidth + "px";
      svg.style.height = logicalHeight + "px";
    }
  }

  updateConnections() {
    const svg = document.getElementById("connections");
    const canvas = document.getElementById("canvas");
    const mainChain = this.getMainChain();

    // Clear existing connection lines (except temp line)
    Array.from(svg.children).forEach((child) => {
      if (child !== this.tempLine) {
        child.remove();
      }
    });

    // Draw all connections
    this.connections.forEach((connection) => {
      const fromNode = this.nodes.find((n) => n.id === connection.from);
      const toNode = this.nodes.find((n) => n.id === connection.to);

      if (!fromNode || !toNode) return;

      const fromElement = document.getElementById(fromNode.id);
      const toElement = document.getElementById(toNode.id);

      if (!fromElement || !toElement) return;

      const fromOutput = fromElement.querySelector(".connection-point.output");
      const toInput = toElement.querySelector(".connection-point.input");

      // Get connection point positions relative to their parent nodes
      const fromOutputRect = fromOutput.getBoundingClientRect();
      const toInputRect = toInput.getBoundingClientRect();
      const fromNodeRect = fromElement.getBoundingClientRect();
      const toNodeRect = toElement.getBoundingClientRect();

      // Calculate positions within the canvas coordinate system (divide screen-space offsets by zoom)
      const x1 =
        fromNode.x +
        (fromOutputRect.left - fromNodeRect.left + fromOutputRect.width / 2) /
          this.zoomLevel;
      const y1 =
        fromNode.y +
        (fromOutputRect.top - fromNodeRect.top + fromOutputRect.height / 2) /
          this.zoomLevel;
      const x2 =
        toNode.x +
        (toInputRect.left - toNodeRect.left + toInputRect.width / 2) /
          this.zoomLevel;
      const y2 =
        toNode.y +
        (toInputRect.top - toNodeRect.top + toInputRect.height / 2) /
          this.zoomLevel;

      // Create curved path
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const offset = Math.min(dist / 2, 100);

      const pathData = `M ${x1} ${y1} C ${x1 + offset} ${y1}, ${x2 - offset} ${y2}, ${x2} ${y2}`;
      path.setAttribute("d", pathData);

      // Check if this connection is part of the main chain
      const isMainChain =
        mainChain.has(connection.from) && mainChain.has(connection.to);
      path.setAttribute("stroke", isMainChain ? "#4a9eff" : "#666");
      path.setAttribute("stroke-width", "3");
      path.setAttribute("fill", "none");
      path.style.pointerEvents = "stroke";
      path.style.cursor = "pointer";
      if (!isMainChain) {
        path.style.opacity = "0.6";
      }

      // Click to remove connection
      path.addEventListener("click", () => {
        this.removeConnection(connection);
        this.updateConnections();
        this.hasUnsavedChanges = true;
        this.savedCompositionId = null; // Clear saved ID on changes
        this.publishedScript = null; // Clear published script on changes
        this.updateMetadata();
      });

      svg.appendChild(path);
    });

    // Update node styles based on main chain
    this.updateNodeStyles();
  }

  selectNode(nodeId) {
    // Deselect all nodes first
    this.deselectAllNodes();

    // Select the new node
    this.selectedNode = nodeId;
    const nodeElement = document.getElementById(nodeId);
    if (nodeElement) {
      nodeElement.classList.add("selected");
    }
  }

  deselectAllNodes() {
    this.selectedNode = null;
    document.querySelectorAll(".script-node").forEach((node) => {
      node.classList.remove("selected");
    });
  }

  removeNode(nodeId) {
    // Remove all connections involving this node
    this.connections = this.connections.filter(
      (c) => c.from !== nodeId && c.to !== nodeId,
    );

    // Clean up connection references in other nodes
    this.nodes.forEach((node) => {
      // Remove this node from input connections
      if (node.connections.input === nodeId) {
        node.connections.input = null;
      }
      // Remove this node from output connections
      node.connections.output = node.connections.output.filter(
        (id) => id !== nodeId,
      );
    });

    // Remove from nodes array
    this.nodes = this.nodes.filter((n) => n.id !== nodeId);

    // Remove DOM element
    const nodeElement = document.getElementById(nodeId);
    if (nodeElement) {
      nodeElement.remove();
    }

    this.updateConnections();
    this.updateCanvasSize();
    this.hasUnsavedChanges = true;
    this.savedCompositionId = null; // Clear saved ID on changes
    this.publishedScript = null; // Clear published script on changes
    this.updateMetadata();

    // Clear selection if this was the selected node
    if (this.selectedNode === nodeId) {
      this.selectedNode = null;
    }
  }

  clearCanvas() {
    if (this.nodes.length === 0) return;

    if (confirm("Clear all nodes from the canvas?")) {
      this.nodes.forEach((node) => {
        const nodeElement = document.getElementById(node.id);
        if (nodeElement) {
          nodeElement.remove();
        }
      });

      this.nodes = [];
      this.connections = [];
      this.updateConnections();

      // Reset canvas size to minimum
      const canvas = document.getElementById("canvas");
      const svg = document.getElementById("connections");
      if (canvas) {
        canvas.style.width = "100%";
        canvas.style.height = "100%";
      }
      if (svg) {
        svg.style.width = "100%";
        svg.style.height = "100%";
      }

      this.hasUnsavedChanges = false;
      this.compositionName = "Untitled";
      this.savedCompositionId = null; // Clear saved ID when clearing canvas
      this.publishedScript = null; // Clear published script when clearing canvas
      this.updateUrlComposition(null);
      this.updateMetadata();
    }
  }

  getOrderedBlocks() {
    // Build dependency graph and return topologically sorted blocks
    // Only include blocks that are part of the main connected chain
    const mainChain = this.getMainChain();
    const sorted = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (nodeId) => {
      if (visited.has(nodeId)) return true;
      if (visiting.has(nodeId)) {
        console.warn("Circular dependency detected!");
        return false;
      }

      visiting.add(nodeId);

      const node = this.nodes.find((n) => n.id === nodeId);
      if (!node) return true;

      // Visit dependencies (input node)
      if (node.connections.input) {
        if (!visit(node.connections.input)) return false;
      }

      visiting.delete(nodeId);
      visited.add(nodeId);
      sorted.push(node.blockId);

      return true;
    };

    // Find root nodes (no input) that are part of the main chain
    const rootNodes = this.nodes.filter(
      (n) => !n.connections.input && mainChain.has(n.id),
    );

    if (rootNodes.length === 0 && this.nodes.length > 0) {
      // If no root nodes in main chain, there's a cycle or all nodes are disconnected
      // Return empty array - no connected blocks to compose
      return [];
    } else {
      // Only visit root nodes that are in the main chain
      rootNodes.forEach((node) => visit(node.id));

      // Visit any remaining unvisited nodes that are in the main chain
      // This ensures we include all connected descendants of root nodes
      this.nodes.forEach((node) => {
        if (!visited.has(node.id) && mainChain.has(node.id)) {
          visit(node.id);
        }
      });
    }

    return sorted;
  }

  saveComposition() {
    // Open the modal first
    document.getElementById("saveModal").classList.add("active");

    if (this.nodes.length === 0) {
      // Show error message in modal
      const errorMessage = document.getElementById("saveErrorMessage");
      const errorInfo = document.getElementById("saveErrorInfo");
      const footer = document.getElementById("saveModalFooter");
      const nameInput = document.getElementById("compositionName");

      if (errorMessage) errorMessage.classList.add("visible");
      if (errorInfo) {
        errorInfo.textContent =
          "No nodes to save! Add some blocks to the canvas first.";
      }
      if (nameInput) nameInput.disabled = true;

      // Change footer to just "Close"
      if (footer) {
        footer.innerHTML = `
          <button class="btn primary" onclick="app.closeSaveModal()">Close</button>
        `;
      }
      return;
    }

    // Set the composition name input to current composition name
    const nameInput = document.getElementById("compositionName");
    if (nameInput && this.compositionName) {
      nameInput.value = this.compositionName;
    }

    // Check for disconnected blocks
    const mainChain = this.getMainChain();
    const notConnectedCount = this.nodes.length - mainChain.size;

    if (notConnectedCount > 0) {
      // Show error message in modal
      const errorMessage = document.getElementById("saveErrorMessage");
      const errorInfo = document.getElementById("saveErrorInfo");
      const footer = document.getElementById("saveModalFooter");

      if (errorMessage) errorMessage.classList.add("visible");
      if (errorInfo) {
        errorInfo.textContent = `You have ${notConnectedCount} disconnected block${notConnectedCount !== 1 ? "s" : ""}. All blocks must be connected to save the composition.`;
      }
      if (nameInput) nameInput.disabled = true;

      // Change footer to just "Close"
      if (footer) {
        footer.innerHTML = `
          <button class="btn primary" onclick="app.closeSaveModal()">Close</button>
        `;
      }
      return;
    }

    // Focus the input field after modal opens
    setTimeout(() => {
      const nameInput = document.getElementById("compositionName");
      if (nameInput) {
        nameInput.focus();
        nameInput.select();
      }
    }, 100);
  }

  closeSaveModal() {
    const modal = document.getElementById("saveModal");
    modal.classList.remove("active");

    // Reset modal state
    const successMessage = document.getElementById("saveSuccessMessage");
    const errorMessage = document.getElementById("saveErrorMessage");
    const footer = document.getElementById("saveModalFooter");
    const nameInput = document.getElementById("compositionName");

    if (successMessage) successMessage.classList.remove("visible");
    if (errorMessage) errorMessage.classList.remove("visible");
    if (footer) {
      footer.innerHTML = `
        <button class="btn" onclick="app.closeSaveModal()">Cancel</button>
        <button class="btn primary" onclick="app.doSave()">Save</button>
      `;
    }
    if (nameInput) nameInput.disabled = false;
  }

  async doSave() {
    const name = document.getElementById("compositionName").value.trim();
    if (!name) {
      // Show error message in modal
      const errorMessage = document.getElementById("saveErrorMessage");
      const errorInfo = document.getElementById("saveErrorInfo");

      if (errorMessage) errorMessage.classList.add("visible");
      if (errorInfo) {
        errorInfo.textContent = "Please enter a composition name";
      }
      return;
    }

    const blocks = this.getOrderedBlocks();

    try {
      const response = await fetch("/api/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name,
          blocks: blocks,
        }),
      });

      const result = await response.json();

      if (result.success) {
        this.compositionName = name;
        this.savedCompositionId = name; // Store the composition ID
        this.hasUnsavedChanges = false;
        this.updateUrlComposition(name);
        this.updateMetadata();

        // Show success message in modal
        const successMessage = document.getElementById("saveSuccessMessage");
        const footer = document.getElementById("saveModalFooter");
        const nameInput = document.getElementById("compositionName");

        if (successMessage) {
          successMessage.classList.add("visible");
          // Update success message text
          const successTitle = successMessage.querySelector(
            ".save-success-title",
          );
          if (successTitle) {
            successTitle.textContent = "Composition saved successfully!";
          }
        }
        if (nameInput) nameInput.disabled = true;

        // Change footer buttons to just "Close"
        if (footer) {
          footer.innerHTML = `
            <button class="btn primary" onclick="app.closeSaveModal()">Close</button>
          `;
        }
      } else {
        // Show error message in modal
        const errorMessage = document.getElementById("saveErrorMessage");
        const errorInfo = document.getElementById("saveErrorInfo");
        const nameInput = document.getElementById("compositionName");

        if (errorMessage) errorMessage.classList.add("visible");
        if (errorInfo) {
          errorInfo.textContent = "Error saving composition. Please try again.";
        }
        if (nameInput) nameInput.disabled = true;
      }
    } catch (error) {
      console.error("Error saving:", error);

      // Show error message in modal
      const errorMessage = document.getElementById("saveErrorMessage");
      const errorInfo = document.getElementById("saveErrorInfo");
      const nameInput = document.getElementById("compositionName");

      if (errorMessage) errorMessage.classList.add("visible");
      if (errorInfo) {
        errorInfo.textContent = "Error saving composition. Please try again.";
      }
      if (nameInput) nameInput.disabled = true;
    }
  }

  async loadComposition() {
    try {
      // Clear any previous error messages
      const errorMessage = document.getElementById("loadErrorMessage");
      if (errorMessage) errorMessage.classList.remove("visible");

      const response = await fetch("/api/compositions");
      const compositions = await response.json();

      const compositionList = document.getElementById("compositionList");
      compositionList.innerHTML = "";

      if (compositions.length === 0) {
        compositionList.innerHTML =
          '<div style="padding: 20px; text-align: center; color: #999;">No saved compositions found</div>';
      } else {
        let selectedIndex = 0;

        const updateSelection = () => {
          const items = compositionList.querySelectorAll(".composition-item");
          items.forEach((item, index) => {
            if (index === selectedIndex) {
              item.classList.add("selected");
              item.scrollIntoView({ block: "nearest", behavior: "smooth" });
            } else {
              item.classList.remove("selected");
            }
          });
        };

        const isAdmin =
          window.currentUser && window.currentUser.role === "admin";

        compositions.forEach((comp, index) => {
          const item = document.createElement("div");
          item.className = "composition-item";
          item.dataset.compId = comp.id;

          const nameSpan = document.createElement("span");
          nameSpan.className = "composition-name";
          nameSpan.textContent = comp.name;
          item.appendChild(nameSpan);

          if (isAdmin) {
            const deleteIcon = document.createElement("span");
            deleteIcon.className = "composition-delete-icon";
            deleteIcon.textContent = "D";
            deleteIcon.addEventListener("click", (e) => {
              e.stopPropagation();
              e.preventDefault();
              this.deleteCompositionDirect(comp.id);
            });
            item.appendChild(deleteIcon);
          }

          item.onclick = (e) => {
            if (e.target.closest(".composition-delete-icon")) return;
            this.doLoad(comp.id);
          };
          compositionList.appendChild(item);
        });

        // Select first item by default
        updateSelection();

        // Add keyboard navigation
        const keyHandler = (e) => {
          const items = compositionList.querySelectorAll(".composition-item");
          if (items.length === 0) return;

          if (e.key === "ArrowDown") {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelection();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateSelection();
          } else if (e.key === "Enter") {
            e.preventDefault();
            const selectedItem = items[selectedIndex];
            if (selectedItem) {
              this.doLoad(selectedItem.dataset.compId);
            }
          }
        };

        // Store the handler so we can remove it later
        this.loadModalKeyHandler = keyHandler;
        document.addEventListener("keydown", keyHandler);
      }

      document.getElementById("loadModal").classList.add("active");
    } catch (error) {
      console.error("Error loading compositions:", error);

      // Show error message in modal
      const errorMessage = document.getElementById("loadErrorMessage");
      const errorInfo = document.getElementById("loadErrorInfo");

      if (errorMessage) errorMessage.classList.add("visible");
      if (errorInfo) {
        errorInfo.textContent =
          "Could not load compositions. Please try again.";
      }

      document.getElementById("loadModal").classList.add("active");
    }
  }

  closeLoadModal() {
    document.getElementById("loadModal").classList.remove("active");

    // Reset error message
    const errorMessage = document.getElementById("loadErrorMessage");
    if (errorMessage) errorMessage.classList.remove("visible");

    // Remove keyboard handler when closing
    if (this.loadModalKeyHandler) {
      document.removeEventListener("keydown", this.loadModalKeyHandler);
      this.loadModalKeyHandler = null;
    }
  }

  async doLoad(compositionId) {
    try {
      const response = await fetch(`/api/compositions/${compositionId}`);
      const composition = await response.json();

      // Clear current canvas
      this.nodes.forEach((node) => {
        const nodeElement = document.getElementById(node.id);
        if (nodeElement) nodeElement.remove();
      });
      this.nodes = [];
      this.connections = [];

      // === Two-pass layout: render first, measure, then position ===

      const horizontalGap = 50; // Gap between nodes horizontally
      const verticalGap = 40; // Gap between rows vertically
      const canvasContainer = document.querySelector(".canvas-container");
      const maxRowWidth = canvasContainer
        ? canvasContainer.clientWidth - 200
        : 1200;

      // First pass: create all nodes at (0, 0) to render and measure them
      const tempNodes = [];
      composition.blocks.forEach((blockId) => {
        const block = this.blocks.find((b) => b.id === blockId);
        if (!block) {
          console.warn(`Block ${blockId} not found`);
          return;
        }

        const nodeId = `node-${this.nextNodeId++}`;
        const node = {
          id: nodeId,
          blockId: blockId,
          blockName: block.name,
          x: 0,
          y: 0,
          connections: {
            input: null,
            output: [],
          },
        };

        this.nodes.push(node);
        this.renderNode(node);
        tempNodes.push(node);
      });

      // Allow the browser to lay out the nodes so we can measure them
      // Force a reflow by reading a layout property
      const canvas = document.getElementById("canvas");
      canvas.offsetHeight;

      // Measure actual node dimensions
      const nodeSizes = tempNodes.map((node) => {
        const el = document.getElementById(node.id);
        return {
          node,
          width: el ? el.offsetWidth : 300,
          height: el ? el.offsetHeight : 150,
        };
      });

      // Second pass: calculate positions using actual dimensions
      // Distribute in rows, wrapping when a row exceeds maxRowWidth
      const rows = [];
      let currentRow = [];
      let currentRowWidth = 0;

      nodeSizes.forEach((entry) => {
        const neededWidth =
          currentRow.length > 0 ? entry.width + horizontalGap : entry.width;

        if (
          currentRow.length > 0 &&
          currentRowWidth + neededWidth > maxRowWidth
        ) {
          // Start a new row
          rows.push(currentRow);
          currentRow = [entry];
          currentRowWidth = entry.width;
        } else {
          currentRow.push(entry);
          currentRowWidth += neededWidth;
        }
      });
      if (currentRow.length > 0) {
        rows.push(currentRow);
      }

      // Assign positions row by row
      let y = 0;
      let totalWidth = 0;
      let totalHeight = 0;

      rows.forEach((row) => {
        let x = 0;
        let rowMaxHeight = 0;

        row.forEach((entry) => {
          entry.node.x = x;
          entry.node.y = y;
          rowMaxHeight = Math.max(rowMaxHeight, entry.height);
          x += entry.width + horizontalGap;
        });

        totalWidth = Math.max(totalWidth, x - horizontalGap);
        y += rowMaxHeight + verticalGap;
        totalHeight = y - verticalGap;
      });

      // Center the layout in the viewport
      const viewportWidth = canvasContainer
        ? canvasContainer.clientWidth
        : window.innerWidth;
      const viewportHeight = canvasContainer
        ? canvasContainer.clientHeight
        : window.innerHeight;

      const offsetX = Math.max(
        50,
        (viewportWidth / this.zoomLevel - totalWidth) / 2,
      );
      const offsetY = Math.max(
        50,
        (viewportHeight / this.zoomLevel - totalHeight) / 2,
      );

      // Third pass: apply final positions and connect nodes
      const prevNode = { id: null };
      tempNodes.forEach((node) => {
        node.x += offsetX;
        node.y += offsetY;

        const el = document.getElementById(node.id);
        if (el) {
          el.style.left = `${node.x}px`;
          el.style.top = `${node.y}px`;
        }

        // Connect to previous node
        if (prevNode.id) {
          this.connections.push({
            from: prevNode.id,
            to: node.id,
          });

          const prevNodeObj = this.nodes.find((n) => n.id === prevNode.id);
          prevNodeObj.connections.output.push(node.id);
          node.connections.input = prevNode.id;
        }

        prevNode.id = node.id;
      });

      this.updateConnections();
      this.updateCanvasSize();
      this.compositionName = composition.name || compositionId;
      this.savedCompositionId = compositionId; // Store the loaded composition ID
      this.hasUnsavedChanges = false;
      this.updateUrlComposition(this.compositionName);
      this.updateMetadata();
      this.updateVariablesList(); // Update variables list after loading
      this.autoOpenVariablesPanelIfNeeded(); // Auto-open if variables exist
      this.closeLoadModal();
    } catch (error) {
      console.error("Error loading composition:", error);

      // Show error message in load modal
      const errorMessage = document.getElementById("loadErrorMessage");
      const errorInfo = document.getElementById("loadErrorInfo");

      if (errorMessage) errorMessage.classList.add("visible");
      if (errorInfo) {
        errorInfo.textContent = "Could not load composition. Please try again.";
      }
    }
  }

  // Find a position that doesn't overlap with existing nodes
  findNonOverlappingPosition(startX, startY) {
    const nodeWidth = 300;
    const nodeHeight = 150; // Approximate node dimensions
    const minSpacing = 20;
    const maxAttempts = 50;

    // Check if position overlaps with any existing node
    const checkOverlap = (x, y) => {
      for (const node of this.nodes) {
        const dx = Math.abs(node.x - x);
        const dy = Math.abs(node.y - y);
        if (dx < nodeWidth + minSpacing && dy < nodeHeight + minSpacing) {
          return true; // Overlaps
        }
      }
      return false; // No overlap
    };

    // Try the initial position first
    if (!checkOverlap(startX, startY)) {
      return { x: startX, y: startY };
    }

    // Try positions in a spiral pattern around the center
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const angle = attempt * 137.5 * (Math.PI / 180); // Golden angle for good distribution
      const distance = 50 + attempt * 30; // Increase distance with each attempt

      const x = startX + Math.cos(angle) * distance;
      const y = startY + Math.sin(angle) * distance;

      if (!checkOverlap(x, y)) {
        return { x, y };
      }
    }

    // If all else fails, add some random offset
    return {
      x: startX + (Math.random() - 0.5) * 400,
      y: startY + (Math.random() - 0.5) * 300,
    };
  }

  // Create New Block functionality
  createNewBlock() {
    this.editingBlockId = null;
    this.isCreatingNewBlock = true;
    this.editBlockHasChanges = false;
    this.editBlockOriginalName = "";
    this.editBlockOriginalContent = "";
    this.editBlockOriginalTags = "";

    // Open modal
    const modal = document.getElementById("editBlockModal");
    const modalTitle = modal.querySelector(".modal-header h2");
    if (modalTitle) {
      modalTitle.textContent = "Create New Block";
    }

    // Clear form
    const nameInput = document.getElementById("editBlockName");
    const tagsInput = document.getElementById("editBlockTags");
    const contentInput = document.getElementById("editBlockContent");
    if (nameInput) nameInput.value = "";
    if (tagsInput) tagsInput.value = "";
    if (contentInput) contentInput.value = "";

    // Clear messages
    const errorMessage = document.getElementById("editBlockErrorMessage");
    const successMessage = document.getElementById("editBlockSuccessMessage");
    if (errorMessage) errorMessage.classList.remove("visible");
    if (successMessage) successMessage.classList.remove("visible");

    // Setup keyboard handlers
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeEditBlockModal();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.doEditBlock();
      }
    };

    nameInput.onkeydown = handleKeyDown;
    contentInput.onkeydown = handleKeyDown;

    // Setup change tracking
    const trackChanges = () => {
      const currentName = nameInput.value;
      const currentContent = contentInput.value;
      const currentTags = tagsInput ? tagsInput.value : "";
      this.editBlockHasChanges =
        currentName !== this.editBlockOriginalName ||
        currentContent !== this.editBlockOriginalContent ||
        currentTags !== this.editBlockOriginalTags;
    };

    nameInput.oninput = trackChanges;
    if (tagsInput) tagsInput.oninput = trackChanges;
    contentInput.oninput = trackChanges;

    // Reset footer
    const footer = document.getElementById("editBlockModalFooter");
    if (footer) {
      footer.innerHTML = `
        <div style="flex: 1; color: #999; font-size: 0.85rem; display: flex; align-items: center;">
          <span><kbd style="background: #3a3a3a; padding: 2px 6px; border-radius: 3px; font-size: 0.8rem;">Esc</kbd> to close • <kbd style="background: #3a3a3a; padding: 2px 6px; border-radius: 3px; font-size: 0.8rem;">Ctrl+Enter</kbd> to create</span>
        </div>
        <button class="btn" onclick="app.closeEditBlockModal()">Cancel</button>
        <button class="btn primary" onclick="app.doEditBlock()">Create Block</button>
      `;
    }

    modal.classList.add("active");

    // Hide delete button when creating new block
    const deleteBtn = document.getElementById("deleteBlockBtn");
    if (deleteBtn) {
      deleteBtn.style.display = "none";
    }

    // Focus on name input
    setTimeout(() => {
      if (nameInput) nameInput.focus();
    }, 100);
  }

  // Edit Block functionality
  editBlock(blockId) {
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block) return;

    // Store the block ID being edited and original values
    this.editingBlockId = blockId;
    this.isCreatingNewBlock = false;
    this.editBlockOriginalName = block.name;
    this.editBlockOriginalContent = block.content;
    this.editBlockOriginalTags = block.tags || "";
    this.editBlockHasChanges = false;

    // Open modal
    const modal = document.getElementById("editBlockModal");
    const modalTitle = modal.querySelector(".modal-header h2");
    if (modalTitle) {
      modalTitle.textContent = "Edit Block";
    }
    modal.classList.add("active");

    // Populate fields
    const nameInput = document.getElementById("editBlockName");
    const tagsInput = document.getElementById("editBlockTags");
    const contentInput = document.getElementById("editBlockContent");
    nameInput.value = block.name;
    if (tagsInput) tagsInput.value = block.tags || "";
    contentInput.value = block.content;

    // Clear any previous messages
    const errorMessage = document.getElementById("editBlockErrorMessage");
    const successMessage = document.getElementById("editBlockSuccessMessage");
    if (errorMessage) errorMessage.classList.remove("visible");
    if (successMessage) successMessage.classList.remove("visible");

    // Add change tracking listeners
    const trackChanges = () => {
      const currentName = nameInput.value;
      const currentContent = contentInput.value;
      const currentTags = tagsInput ? tagsInput.value : "";
      this.editBlockHasChanges =
        currentName !== this.editBlockOriginalName ||
        currentContent !== this.editBlockOriginalContent ||
        currentTags !== this.editBlockOriginalTags;
    };

    nameInput.addEventListener("input", trackChanges);
    if (tagsInput) tagsInput.addEventListener("input", trackChanges);
    contentInput.addEventListener("input", trackChanges);

    // Add keyboard shortcuts
    this.editBlockKeyHandler = (e) => {
      // Escape to close
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeEditBlockModal();
      }
      // Ctrl+Enter to save
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.doEditBlock();
      }
    };

    document.addEventListener("keydown", this.editBlockKeyHandler);

    // Show delete button when editing (not creating)
    const deleteBtn = document.getElementById("deleteBlockBtn");
    if (deleteBtn) {
      deleteBtn.style.display = "inline-flex";
    }
  }

  deleteCompositionDirect(compositionId) {
    this.deletingCompositionId = compositionId;
    this.showDeleteCompositionConfirmation();
  }

  showDeleteCompositionConfirmation() {
    const modal = document.getElementById("deleteCompositionModal");
    if (modal) {
      modal.classList.add("active");
    }
    const errorMessage = document.getElementById("deleteCompositionError");
    if (errorMessage) {
      errorMessage.style.display = "none";
    }
  }

  closeDeleteCompositionConfirmation() {
    const modal = document.getElementById("deleteCompositionModal");
    if (modal) {
      modal.classList.remove("active");
    }
  }

  async doDeleteComposition() {
    if (!this.deletingCompositionId) return;

    try {
      const response = await fetch(
        `/api/compositions/${this.deletingCompositionId}`,
        {
          method: "DELETE",
        },
      );

      if (response.ok) {
        // Remove the composition item from the list in the modal
        const compositionList = document.getElementById("compositionList");
        if (compositionList) {
          const items = compositionList.querySelectorAll(".composition-item");
          items.forEach((item) => {
            if (item.dataset.compId === this.deletingCompositionId) {
              item.remove();
            }
          });

          // Show empty message if no compositions left
          const remaining =
            compositionList.querySelectorAll(".composition-item");
          if (remaining.length === 0) {
            compositionList.innerHTML =
              '<div style="padding: 20px; text-align: center; color: #999;">No saved compositions found</div>';
          }
        }

        this.closeDeleteCompositionConfirmation();
      } else {
        const result = await response.json();
        const errorMessage = document.getElementById("deleteCompositionError");
        if (errorMessage) {
          errorMessage.textContent =
            result.error || "Failed to delete composition";
          errorMessage.style.display = "block";
        }
      }
    } catch (error) {
      console.error("Error deleting composition:", error);
      const errorMessage = document.getElementById("deleteCompositionError");
      if (errorMessage) {
        errorMessage.textContent = "Network error: " + error.message;
        errorMessage.style.display = "block";
      }
    }
  }

  deleteBlockDirect(blockId) {
    this.editingBlockId = blockId;
    this.isCreatingNewBlock = false;
    this.showDeleteBlockConfirmation();
  }

  showDeleteBlockConfirmation() {
    const modal = document.getElementById("deleteBlockModal");
    if (modal) {
      modal.classList.add("active");
    }
    // Clear any previous error messages
    const errorMessage = document.getElementById("deleteBlockError");
    if (errorMessage) {
      errorMessage.style.display = "none";
    }
  }

  closeDeleteBlockConfirmation() {
    const modal = document.getElementById("deleteBlockModal");
    if (modal) {
      modal.classList.remove("active");
    }
  }

  async doDeleteBlock() {
    if (!this.editingBlockId) return;

    try {
      const response = await fetch(`/api/blocks/${this.editingBlockId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        // Remove block from local array
        this.blocks = this.blocks.filter((b) => b.id !== this.editingBlockId);

        // Remove any nodes on canvas that use this block
        const nodesToRemove = this.nodes.filter(
          (n) => n.blockId === this.editingBlockId,
        );
        nodesToRemove.forEach((node) => {
          this.removeNode(node.id);
        });

        // Re-render blocks list
        this.renderBlocks();

        // Close both modals
        this.closeDeleteBlockConfirmation();
        this.closeEditBlockModal(true);
      } else {
        const result = await response.json();
        const errorMessage = document.getElementById("deleteBlockError");
        if (errorMessage) {
          errorMessage.textContent = result.error || "Failed to delete block";
          errorMessage.style.display = "block";
        }
      }
    } catch (error) {
      console.error("Error deleting block:", error);
      const errorMessage = document.getElementById("deleteBlockError");
      if (errorMessage) {
        errorMessage.textContent = "Network error: " + error.message;
        errorMessage.style.display = "block";
      }
    }
  }

  closeEditBlockModal(force = false) {
    // Check for unsaved changes
    if (!force && this.editBlockHasChanges) {
      const confirmClose = confirm(
        "You have unsaved changes. Are you sure you want to close? Your changes will be lost.",
      );
      if (!confirmClose) {
        return;
      }
    }

    document.getElementById("editBlockModal").classList.remove("active");

    // Remove keyboard handler
    if (this.editBlockKeyHandler) {
      document.removeEventListener("keydown", this.editBlockKeyHandler);
      this.editBlockKeyHandler = null;
    }

    // Clear state
    this.editingBlockId = null;
    this.editBlockOriginalName = null;
    this.editBlockOriginalContent = null;
    this.editBlockOriginalTags = null;
    this.editBlockHasChanges = false;

    // Clear messages
    const errorMessage = document.getElementById("editBlockErrorMessage");
    const successMessage = document.getElementById("editBlockSuccessMessage");
    if (errorMessage) errorMessage.classList.remove("visible");
    if (successMessage) successMessage.classList.remove("visible");

    // Reset footer
    const footer = document.getElementById("editBlockModalFooter");
    if (footer) {
      // Setup footer buttons with keyboard hints
      footer.innerHTML = `
        <div style="flex: 1; color: #999; font-size: 0.85rem; display: flex; align-items: center;">
          <span><kbd style="background: #3a3a3a; padding: 2px 6px; border-radius: 3px; font-size: 0.8rem;">Esc</kbd> to close • <kbd style="background: #3a3a3a; padding: 2px 6px; border-radius: 3px; font-size: 0.8rem;">Ctrl+Enter</kbd> to save</span>
        </div>
        <button class="btn" onclick="app.closeEditBlockModal()">Cancel</button>
        <button class="btn" style="background: #f44336; display: none" id="deleteBlockBtn" onclick="app.showDeleteBlockConfirmation()">Delete</button>
        <button class="btn primary" onclick="app.doEditBlock()">Save Changes</button>
      `;
    }

    this.isCreatingNewBlock = false;

    // Hide delete button when modal is reset
    const deleteBtn = document.getElementById("deleteBlockBtn");
    if (deleteBtn) {
      deleteBtn.style.display = "none";
    }
  }

  async doEditBlock() {
    const name = document.getElementById("editBlockName").value.trim();
    const tags = (document.getElementById("editBlockTags")?.value || "").trim();
    const content = document.getElementById("editBlockContent").value;

    // Validation
    if (!name) {
      const errorMessage = document.getElementById("editBlockErrorMessage");
      const errorInfo = document.getElementById("editBlockErrorInfo");
      if (errorMessage) errorMessage.classList.add("visible");
      if (errorInfo) {
        errorInfo.textContent = "Block name is required";
      }
      return;
    }

    try {
      let response, result;

      if (this.isCreatingNewBlock) {
        // Create new block - encode content to base64
        response = await fetch("/api/blocks", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: name,
            tags: tags,
            content: btoa(content),
          }),
        });
      } else {
        // Update existing block - encode content to base64
        if (!this.editingBlockId) return;

        response = await fetch(`/api/blocks/${this.editingBlockId}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: name,
            tags: tags,
            content: btoa(content),
          }),
        });
      }

      result = await response.json();

      if (response.ok && result.success) {
        if (this.isCreatingNewBlock) {
          // Add new block to local blocks array
          await this.loadBlocks();
        } else {
          // Update local blocks array
          const block = this.blocks.find((b) => b.id === this.editingBlockId);
          if (block) {
            block.name = name;
            block.tags = tags;
            block.content = content;
          }

          // Update any nodes on canvas that use this block
          this.nodes.forEach((node) => {
            if (node.blockId === this.editingBlockId) {
              this.reRenderNode(node.id);
            }
          });

          // Mark as having unsaved changes if blocks are on canvas
          if (this.nodes.some((n) => n.blockId === this.editingBlockId)) {
            this.hasUnsavedChanges = true;
            this.savedCompositionId = null; // Clear saved ID on changes
            this.publishedScript = null; // Clear published script on changes
            this.updateMetadata();
            this.updateVariablesList(); // Update variables when block content changes
            this.autoOpenVariablesPanelIfNeeded(); // Auto-open if variables exist
          }
        }

        // Re-render blocks list
        this.renderBlocks();

        // Show success message
        const successMessage = document.getElementById(
          "editBlockSuccessMessage",
        );
        if (successMessage) successMessage.classList.add("visible");

        // Reset change tracking since we saved
        this.editBlockHasChanges = false;
        this.editBlockOriginalName = name;
        this.editBlockOriginalTags = tags;
        this.editBlockOriginalContent = content;

        // Change footer to just "Close"
        const footer = document.getElementById("editBlockModalFooter");
        if (footer) {
          footer.innerHTML = `
            <button class="btn primary" onclick="app.closeEditBlockModal(true)">Close</button>
          `;
        }

        // Auto-close after 1 second
        setTimeout(() => {
          this.closeEditBlockModal(true);
        }, 1000);
      } else {
        // Show error message
        const errorMessage = document.getElementById("editBlockErrorMessage");
        const errorInfo = document.getElementById("editBlockErrorInfo");
        if (errorMessage) errorMessage.classList.add("visible");
        if (errorInfo) {
          errorInfo.textContent =
            result.error || "Error saving block. Please try again.";
        }
      }
    } catch (error) {
      console.error("Error saving block:", error);

      // Show error message
      const errorMessage = document.getElementById("editBlockErrorMessage");
      const errorInfo = document.getElementById("editBlockErrorInfo");
      if (errorMessage) errorMessage.classList.add("visible");
      if (errorInfo) {
        errorInfo.textContent = "Error updating block. Please try again.";
      }
    }
  }

  updateMetadata() {
    // Debounce metadata updates to avoid excessive recalculations
    if (this.metadataUpdateTimeout) {
      clearTimeout(this.metadataUpdateTimeout);
    }
    this.metadataUpdateTimeout = setTimeout(() => {
      this.calculateMetadata();
      this.updatePreview();
    }, 300);
  }

  async calculateMetadata() {
    // Show/hide sections based on composition state
    const emptyStateMessage = document.getElementById("emptyStateMessage");
    const compositionNameSection = document.getElementById(
      "compositionNameSection",
    );
    const sha256Section = document.getElementById("sha256Section");
    const blocksStatusSection = document.getElementById("blocksStatusSection");
    const variablesStatusSection = document.getElementById(
      "variablesStatusSection",
    );
    const urlSection = document.getElementById("urlSection");

    const publishButtonSection = document.getElementById(
      "publishButtonSection",
    );
    const publishStatusSection = document.getElementById(
      "publishStatusSection",
    );

    if (this.nodes.length === 0) {
      // Show empty state, hide all metadata sections
      if (emptyStateMessage) emptyStateMessage.style.display = "block";
      if (compositionNameSection) compositionNameSection.style.display = "none";
      if (sha256Section) sha256Section.style.display = "none";
      if (urlSection) urlSection.style.display = "none";
      if (blocksStatusSection) blocksStatusSection.style.display = "none";
      if (variablesStatusSection) variablesStatusSection.style.display = "none";
      if (publishButtonSection) publishButtonSection.style.display = "none";
      if (publishStatusSection) publishStatusSection.style.display = "none";
      return;
    }

    // Hide empty state, show metadata sections
    if (emptyStateMessage) emptyStateMessage.style.display = "none";
    if (compositionNameSection) compositionNameSection.style.display = "block";
    if (blocksStatusSection) blocksStatusSection.style.display = "block";

    // Update composition name
    const nameDisplay = document.getElementById("compositionNameDisplay");
    if (nameDisplay) {
      nameDisplay.textContent = this.compositionName;
    }

    // Calculate connected and not connected blocks
    const mainChain = this.getMainChain();
    const connectedCount = mainChain.size;
    const notConnectedCount = this.nodes.length - connectedCount;

    // Update blocks status display (connected/not connected)
    const blocksStatusDisplay = document.getElementById("blocksStatusDisplay");
    if (blocksStatusDisplay) {
      // Create the display with separate spans for styling
      const connectedSpan = document.createElement("span");
      connectedSpan.textContent = connectedCount;

      const separator = document.createTextNode(" / ");

      const notConnectedSpan = document.createElement("span");
      notConnectedSpan.textContent = notConnectedCount;

      // Style the not connected count red if > 0
      if (notConnectedCount > 0) {
        notConnectedSpan.style.color = "#f44336";
        notConnectedSpan.style.fontWeight = "bold";
      } else {
        notConnectedSpan.style.color = "";
        notConnectedSpan.style.fontWeight = "";
      }

      // Clear and rebuild the display
      blocksStatusDisplay.innerHTML = "";
      blocksStatusDisplay.appendChild(connectedSpan);
      blocksStatusDisplay.appendChild(separator);
      blocksStatusDisplay.appendChild(notConnectedSpan);
    }

    // Calculate and display variables status (filled/total)
    const allVariables = this.extractVariables();
    const filledVariables = allVariables.filter(
      (varName) =>
        this.variables[varName] && this.variables[varName].trim() !== "",
    );
    const filledCount = filledVariables.length;
    const totalCount = allVariables.length;

    if (totalCount > 0) {
      // Show variables status section
      if (variablesStatusSection)
        variablesStatusSection.style.display = "block";

      const variablesStatusDisplay = document.getElementById(
        "variablesStatusDisplay",
      );
      if (variablesStatusDisplay) {
        // Create the display with separate spans for styling
        const filledSpan = document.createElement("span");
        filledSpan.textContent = filledCount;

        const separator = document.createTextNode(" / ");

        const totalSpan = document.createElement("span");
        totalSpan.textContent = totalCount;

        // Style the filled count red if not all variables are filled
        if (filledCount < totalCount) {
          filledSpan.style.color = "#f44336";
          filledSpan.style.fontWeight = "bold";
        } else {
          filledSpan.style.color = "";
          filledSpan.style.fontWeight = "";
        }

        // Clear and rebuild the display
        variablesStatusDisplay.innerHTML = "";
        variablesStatusDisplay.appendChild(filledSpan);
        variablesStatusDisplay.appendChild(separator);
        variablesStatusDisplay.appendChild(totalSpan);
      }
    } else {
      // Hide variables status section if no variables
      if (variablesStatusSection) variablesStatusSection.style.display = "none";
    }

    // Check publish prerequisites and update UI accordingly
    const prerequisites = this.checkPublishPrerequisites();
    const passphraseSection = document.getElementById(
      "encryptionPassphraseSection",
    );

    if (!prerequisites.canPublish) {
      // Show issues pending status
      if (publishStatusSection) publishStatusSection.style.display = "block";
      if (publishButtonSection) publishButtonSection.style.display = "none";
      if (passphraseSection) passphraseSection.style.display = "none";

      const publishStatusDisplay = document.getElementById(
        "publishStatusDisplay",
      );
      if (publishStatusDisplay) {
        publishStatusDisplay.innerHTML = `<span style="color: #f44336; font-weight: bold;">Issues Pending</span>`;
      }
    } else {
      // Show passphrase section and publish button when ready
      if (publishStatusSection) publishStatusSection.style.display = "none";
      if (passphraseSection) passphraseSection.style.display = "block";
      if (publishButtonSection) publishButtonSection.style.display = "block";

      // Clear passphrase fields when showing
      const passphraseInput = document.getElementById("publishPassphrase");
      const confirmInput = document.getElementById("publishPassphraseConfirm");
      const errorDiv = document.getElementById("passphraseError");
      if (passphraseInput) passphraseInput.value = "";
      if (confirmInput) confirmInput.value = "";
      if (errorDiv) errorDiv.style.display = "none";

      // Validate (will disable button initially)
      this.validatePublishPassphrase();
    }

    // Hide SHA256/URL sections - they only appear after publishing
    if (sha256Section) sha256Section.style.display = "none";
    if (urlSection) urlSection.style.display = "none";

    // Check if we have a published script to display
    if (this.publishedScript) {
      this.displayPublishedMetadata(this.publishedScript);
    }
  }

  copyCompositionUrl() {
    if (!this.compositionUrl) {
      console.error("No composition URL available");
      return;
    }

    navigator.clipboard
      .writeText(this.compositionUrl)
      .then(() => {
        // Show temporary feedback
        const copyButton = event.target.closest("button");
        if (copyButton) {
          const originalHTML = copyButton.innerHTML;
          copyButton.innerHTML = "✓";
          setTimeout(() => {
            copyButton.innerHTML = originalHTML;
          }, 1000);
        }
      })
      .catch((err) => {
        console.error("Failed to copy URL:", err);
      });
  }

  // Compose blocks locally without backend call
  composeBlocksLocally(blockIds) {
    let output = "";

    for (const blockId of blockIds) {
      const block = this.blocks.find((b) => b.id === blockId);
      if (!block) {
        output += `# Block not found: ${blockId}\n`;
      } else {
        // Add block name as comment
        output += `# ${block.name}\n`;
        output += block.content;
        // Add separator between blocks if content doesn't end with newline
        if (block.content && !block.content.endsWith("\n")) {
          output += "\n";
        }
      }
      // Add empty line after each block
      output += "\n";
    }

    return output;
  }

  updatePreview() {
    const previewContent = document.getElementById("previewContent");
    const previewStats = document.getElementById("previewStats");

    if (!previewContent) return;

    // Check if there are any nodes
    if (this.nodes.length === 0) {
      previewContent.classList.add("empty");
      previewContent.textContent = "No blocks on canvas";
      if (previewStats) previewStats.textContent = "";
      return;
    }

    try {
      // Get ordered blocks from the main chain (only connected blocks)
      const connectedBlocks = this.getOrderedBlocks();

      if (connectedBlocks.length === 0) {
        previewContent.classList.add("empty");
        previewContent.textContent = "No connected blocks to preview";
        if (previewStats) previewStats.textContent = "";
        return;
      }

      // Compose blocks locally - no backend call needed!
      let fullContent = this.composeBlocksLocally(connectedBlocks);

      // Replace variables in the content
      fullContent = this.replaceVariables(fullContent);

      // Update preview content
      previewContent.classList.remove("empty");

      // Only trigger animation if content actually changed
      const contentChanged = previewContent.textContent !== fullContent;
      previewContent.textContent = fullContent;

      if (contentChanged) {
        // Trigger cyber animation
        previewContent.classList.remove("updating");
        // Force reflow to restart animation
        void previewContent.offsetWidth;
        previewContent.classList.add("updating");

        // Remove animation class after it completes
        setTimeout(() => {
          previewContent.classList.remove("updating");
        }, 800); // Match animation duration
      }

      // Update stats
      if (previewStats) {
        const charCount = fullContent.length;
        previewStats.textContent = `${connectedBlocks.length} block${connectedBlocks.length !== 1 ? "s" : ""} • ${charCount} characters`;
      }
    } catch (error) {
      console.error("Error updating preview:", error);
      previewContent.classList.add("empty");
      previewContent.textContent = "Error loading preview";
      if (previewStats) previewStats.textContent = "";
    }
  }

  // Extract all variables from connected blocks
  extractVariables() {
    const variables = new Set();
    const connectedBlocks = this.getOrderedBlocks();

    // Get block content for connected blocks
    connectedBlocks.forEach((blockId) => {
      const block = this.blocks.find((b) => b.id === blockId);
      if (block && block.content) {
        // Match {{ variable_name }} pattern
        const regex = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
        let match;
        while ((match = regex.exec(block.content)) !== null) {
          variables.add(match[1]);
        }
      }
    });

    return Array.from(variables).sort();
  }

  // Update the variables panel UI
  updateVariablesList() {
    const variablesContent = document.getElementById("variablesContent");
    if (!variablesContent) return;

    const variables = this.extractVariables();

    if (variables.length === 0) {
      variablesContent.innerHTML = `
        <div class="variables-empty">
          No variables found. Use {{ variable_name }} in your blocks.
        </div>
      `;
      return;
    }

    // Build the variables input list with header
    let html = `
      <div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #4a4a4a;">
        <div style="font-size: 0.85rem; color: #999;">
          Found ${variables.length} variable${variables.length !== 1 ? "s" : ""} in connected blocks
        </div>
      </div>
    `;

    variables.forEach((varName) => {
      const value = this.variables[varName] || "";
      html += `
        <div class="variable-item">
          <label for="var_${varName}">{{ ${varName} }}</label>
          <input
            type="text"
            id="var_${varName}"
            data-variable="${varName}"
            value="${this.escapeHtml(value)}"
            placeholder="Enter value for ${varName}"
          />
        </div>
      `;
    });

    variablesContent.innerHTML = html;

    // Add event listeners to save variable values
    variables.forEach((varName) => {
      const input = document.getElementById(`var_${varName}`);
      if (input) {
        input.addEventListener("input", (e) => {
          this.variables[varName] = e.target.value;
          this.publishedScript = null; // Clear published script when variables change
          this.saveVariables(); // Save to localStorage
          this.updateMetadata(); // Update metadata to reflect filled count
          this.updatePreview(); // Update preview when variable changes (now local!)
        });
      }
    });
  }

  // Helper to escape HTML
  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Replace variables in content with their values
  replaceVariables(content) {
    let result = content;
    Object.keys(this.variables).forEach((varName) => {
      const regex = new RegExp(`\\{\\{\\s*${varName}\\s*\\}\\}`, "g");
      result = result.replace(regex, this.variables[varName] || "");
    });
    return result;
  }

  // Check if all prerequisites for publishing are fulfilled
  checkPublishPrerequisites() {
    const issues = [];

    // Check if all blocks are connected
    const mainChain = this.getMainChain();
    const notConnectedCount = this.nodes.length - mainChain.size;

    if (notConnectedCount > 0) {
      issues.push(
        `${notConnectedCount} block${notConnectedCount !== 1 ? "s" : ""} not connected`,
      );
    }

    // Check if all variables are filled
    const allVariables = this.extractVariables();
    const unfilledVariables = allVariables.filter(
      (varName) =>
        !this.variables[varName] || this.variables[varName].trim() === "",
    );

    if (unfilledVariables.length > 0) {
      issues.push(
        `${unfilledVariables.length} variable${unfilledVariables.length !== 1 ? "s" : ""} not filled`,
      );
    }

    return {
      canPublish: issues.length === 0,
      issues: issues,
    };
  }

  // Publish the composition
  validatePublishPassphrase() {
    const passphraseInput = document.getElementById("publishPassphrase");
    const confirmInput = document.getElementById("publishPassphraseConfirm");
    const errorDiv = document.getElementById("passphraseError");
    const publishButton = document.getElementById("publishButton");

    if (!passphraseInput || !confirmInput || !errorDiv || !publishButton) {
      return;
    }

    const passphrase = passphraseInput.value;
    const confirm = confirmInput.value;

    // Clear previous error
    errorDiv.style.display = "none";
    errorDiv.textContent = "";

    // Check if both fields have values
    if (!passphrase || !confirm) {
      publishButton.disabled = true;
      return;
    }

    // Check if passphrases match
    if (passphrase !== confirm) {
      errorDiv.textContent = "Passphrases do not match";
      errorDiv.style.display = "block";
      publishButton.disabled = true;
      return;
    }

    // Validate passphrase with crypto module
    const validation = NaginiCrypto.validatePassphrase(passphrase);
    if (!validation.valid) {
      errorDiv.textContent = validation.error;
      errorDiv.style.display = "block";
      publishButton.disabled = true;
      return;
    }

    // All good - enable publish button
    publishButton.disabled = false;
  }

  async publishComposition() {
    // Final validation check
    const prerequisites = this.checkPublishPrerequisites();

    if (!prerequisites.canPublish) {
      alert("Cannot publish: " + prerequisites.issues.join(", "));
      return;
    }

    // Get passphrase from inline fields
    const passphraseInput = document.getElementById("publishPassphrase");
    const confirmInput = document.getElementById("publishPassphraseConfirm");

    if (!passphraseInput || !confirmInput) {
      alert("Passphrase fields not found");
      return;
    }

    const passphrase = passphraseInput.value;
    const confirm = confirmInput.value;

    // Validate inputs (should already be validated, but double-check)
    if (!passphrase || !confirm) {
      alert("Please enter and confirm your passphrase");
      return;
    }

    if (passphrase !== confirm) {
      alert("Passphrases do not match");
      return;
    }

    // Validate passphrase with crypto module
    const validation = NaginiCrypto.validatePassphrase(passphrase);
    if (!validation.valid) {
      alert(validation.error);
      return;
    }

    // Show loading state on publish button
    const publishButton = document.getElementById("publishButton");
    if (publishButton) {
      publishButton.disabled = true;
      publishButton.innerHTML = "Encrypting & Publishing...";
    }

    try {
      // Get the composed content
      const blocks = this.getOrderedBlocks();

      // Compose blocks locally - no backend call needed!
      let content = this.composeBlocksLocally(blocks);

      // Replace variables in the content
      content = this.replaceVariables(content);

      // Encrypt the content
      const encryptedContent = await NaginiCrypto.encrypt(content, passphrase);

      // Now publish the encrypted content
      const publishResponse = await fetch("/api/publish-encrypted", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          encrypted_content: encryptedContent,
          compositionId: this.savedCompositionId || null,
        }),
      });

      const result = await publishResponse.json();

      if (result.success) {
        // Store published script info
        this.publishedScript = result;

        // Hide passphrase section and publish button
        const passphraseSection = document.getElementById(
          "encryptionPassphraseSection",
        );
        const publishButtonSection = document.getElementById(
          "publishButtonSection",
        );
        const publishStatusSection = document.getElementById(
          "publishStatusSection",
        );
        if (passphraseSection) passphraseSection.style.display = "none";
        if (publishButtonSection) publishButtonSection.style.display = "none";
        if (publishStatusSection) publishStatusSection.style.display = "none";

        // Show SHA256, URL, and QR code sections with published data
        this.displayPublishedMetadata(result);
      } else {
        alert("Failed to publish: " + (result.error || "Unknown error"));
      }
    } catch (error) {
      console.error("Error encrypting/publishing composition:", error);
      alert("Error encrypting/publishing composition: " + error.message);
    } finally {
      // Reset button state
      if (publishButton) {
        publishButton.disabled = false;
        publishButton.innerHTML = "Encrypt & Publish";
      }
    }
  }

  // Display published script metadata in the metadata panel
  displayPublishedMetadata(result) {
    const sha256Section = document.getElementById("sha256Section");
    const urlSection = document.getElementById("urlSection");

    // Show SHA256 section
    if (sha256Section) sha256Section.style.display = "block";

    const sha256Label = document.getElementById("sha256Label");
    if (sha256Label) {
      sha256Label.textContent = "SHA256 Hash:";
    }

    const hashDisplay = document.getElementById("sha256HashDisplay");
    if (hashDisplay) {
      hashDisplay.textContent = result.checksum;
      hashDisplay.style.fontStyle = "normal";
      hashDisplay.style.color = "";
    }

    // Show URL section
    if (urlSection) urlSection.style.display = "block";
    const urlLink = document.getElementById("compositionUrlLink");
    if (urlLink) {
      urlLink.href = result.full_url;
      urlLink.textContent = result.full_url;
    }

    // Store URL for copying
    this.compositionUrl = result.full_url;
  }

  // Auto-open variables panel if variables are detected
  autoOpenVariablesPanelIfNeeded() {
    const variables = this.extractVariables();
    if (variables.length > 0) {
      const panel = document.getElementById("variablesPanel");
      if (panel && panel.classList.contains("hidden")) {
        showVariablesPanel();
      }
    }
  }

  // Load variables from localStorage
  loadVariables() {
    try {
      const saved = localStorage.getItem("nagini-variables");
      if (saved) {
        this.variables = JSON.parse(saved);
      }
    } catch (error) {
      console.error("Failed to load variables from localStorage:", error);
      this.variables = {};
    }
  }

  // Save variables to localStorage
  saveVariables() {
    try {
      localStorage.setItem("nagini-variables", JSON.stringify(this.variables));
    } catch (error) {
      console.error("Failed to save variables to localStorage:", error);
    }
  }

  // Import variables from JSON file
  importVariablesFromFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const importedData = JSON.parse(e.target.result);

        // Validate that it's an object
        if (typeof importedData !== "object" || Array.isArray(importedData)) {
          console.error("Invalid JSON format:", importedData);
          this.showImportMessage(
            "error",
            'Invalid JSON format. Expected an object with key-value pairs like:<br>{ "username": "john", "api_key": "abc123" }',
          );
          return;
        }

        // Get current variables in the composition
        const currentVariables = this.extractVariables();

        if (currentVariables.length === 0) {
          this.showImportMessage(
            "error",
            "No variables found in the current composition. Add blocks with {{ variable_name }} syntax first.",
          );
          return;
        }

        // Only import variables that exist in the current composition
        let importedCount = 0;
        let ignoredCount = 0;

        Object.keys(importedData).forEach((key) => {
          if (currentVariables.includes(key)) {
            this.variables[key] = String(importedData[key]);
            importedCount++;
          } else {
            ignoredCount++;
          }
        });

        // Save to localStorage
        this.saveVariables();

        // Update the UI
        this.updateVariablesList();

        // Update metadata to reflect filled count
        this.updateMetadata();

        // Update preview
        this.updatePreview();

        // Show feedback
        if (importedCount === 0) {
          this.showImportMessage(
            "error",
            `No matching variables found. The JSON file contains variables that don't exist in your composition.<br><br>Expected variables: ${currentVariables.join(", ")}`,
          );
        } else {
          let message = `✓ Successfully imported ${importedCount} variable${importedCount !== 1 ? "s" : ""}!`;
          if (ignoredCount > 0) {
            message += `<br><br>⚠ Ignored ${ignoredCount} unknown variable${ignoredCount !== 1 ? "s" : ""} not used in your composition.`;
          }
          this.showImportMessage("success", message);
        }
      } catch (error) {
        console.error("Failed to parse JSON:", error);
        this.showImportMessage(
          "error",
          "Failed to parse JSON file. Please ensure it's a valid JSON file.<br><br>Error: " +
            error.message,
        );
      }

      // Reset the file input so the same file can be imported again
      event.target.value = "";
    };

    reader.readAsText(file);
  }

  // Show import message in the variables panel
  showImportMessage(type, message) {
    const messageDiv = document.getElementById("variablesImportMessage");
    if (!messageDiv) return;

    // Set styling based on type
    if (type === "success") {
      messageDiv.style.background = "rgba(76, 175, 80, 0.1)";
      messageDiv.style.border = "1px solid #4caf50";
      messageDiv.style.color = "#4caf50";
    } else if (type === "error") {
      messageDiv.style.background = "rgba(244, 67, 54, 0.1)";
      messageDiv.style.border = "1px solid #f44336";
      messageDiv.style.color = "#f44336";
    }

    messageDiv.innerHTML = message;
    messageDiv.style.display = "block";

    // Auto-hide success messages after 5 seconds
    if (type === "success") {
      setTimeout(() => {
        messageDiv.style.display = "none";
      }, 5000);
    }
  }
}

window.app = null;
document.addEventListener("DOMContentLoaded", () => {
  window.app = new NaginiApp();
});
